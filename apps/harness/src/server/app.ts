import type { Database } from "bun:sqlite";
import type { EventLog } from "../events/log";
import { createSession, getSession, listEntries, listSessions } from "../core/sessions";
import type { ConversationDeps } from "../surfaces/conversation/loop";
import { runTurn } from "../surfaces/conversation/loop";

export type AppDeps = {
  readonly db: Database;
  readonly events: EventLog;
  readonly conversation: ConversationDeps;
  readonly webRoot: string;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function sse(request: Request, deps: AppDeps, after: number, sessionId: string | null): Response {
  const encoder = new TextEncoder();
  let lastWritten = after;
  let cleanup: (() => void) | undefined;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: { seq: number; kind: string; payload: unknown; sessionId: string | null }) => {
        if (event.seq <= lastWritten) return;
        if (sessionId && event.sessionId !== sessionId) return;
        lastWritten = event.seq;
        controller.enqueue(
          encoder.encode(`id: ${event.seq}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`),
        );
      };
      const snapshot = {
        sessions: listSessions(deps.db),
        entries: sessionId ? listEntries(deps.db, sessionId) : [],
        lastSeq: deps.events.lastSeq(),
      };
      controller.enqueue(encoder.encode(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`));
      for (const event of deps.events.after(after, sessionId ?? undefined)) send(event);

      const unsubscribe = deps.events.subscribe(send);
      const ping = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          cleanup?.();
        }
      }, 15_000);
      cleanup = () => {
        clearInterval(ping);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      request.signal.addEventListener("abort", () => cleanup?.(), { once: true });
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    },
  });
}

async function serveStatic(deps: AppDeps, pathname: string): Promise<Response> {
  const file = pathname === "/" || pathname === "" ? "index.html" : pathname.replace(/^\/+/, "");
  if (file.includes("..")) return new Response("not found", { status: 404 });
  const candidates = [deps.webRoot, `${deps.webRoot}/assets`];
  for (const root of candidates) {
    const handle = Bun.file(`${root}/${file}`);
    if (await handle.exists()) {
      const type = file.endsWith(".js") ? "text/javascript; charset=utf-8" : file.endsWith(".css") ? "text/css; charset=utf-8" : "text/html; charset=utf-8";
      return new Response(handle, { headers: { "content-type": type, "cache-control": "no-cache" } });
    }
  }
  return new Response("client build missing: run `bun run build:web`", { status: 404 });
}

export function createApp(deps: AppDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/health") return json({ ok: true, lastSeq: deps.events.lastSeq() });

    if (path === "/api/events" && request.method === "GET") {
      const after = Number(url.searchParams.get("after") ?? "0");
      const session = url.searchParams.get("session");
      return sse(request, deps, Number.isFinite(after) ? after : 0, session);
    }

    if (path === "/api/sessions") {
      if (request.method === "GET") return json({ sessions: listSessions(deps.db) });
      if (request.method === "POST") {
        const raw = (await request.json().catch(() => ({}))) as { title?: unknown };
        const title = typeof raw.title === "string" && raw.title.trim().length > 0 ? raw.title.trim() : "새 대화";
        const session = createSession(deps.db, title);
        deps.events.append({ kind: "session.created", sessionId: session.id, payload: { id: session.id, title: session.title } });
        return json(session, 201);
      }
    }

    const sessionMatch = /^\/api\/sessions\/([^/]+)(?:\/(entries|messages))?$/.exec(path);
    if (sessionMatch) {
      const id = sessionMatch[1] ?? "";
      const session = getSession(deps.db, id);
      if (!session) return json({ error: "session_not_found" }, 404);

      if (sessionMatch[2] === "entries" && request.method === "GET") {
        return json({ entries: listEntries(deps.db, id) });
      }
      if (sessionMatch[2] === "messages" && request.method === "POST") {
        const raw = (await request.json().catch(() => null)) as { text?: unknown } | null;
        const text = typeof raw?.text === "string" ? raw.text.trim() : "";
        if (text.length === 0 || text.length > 8_000) return json({ error: "invalid_text" }, 422);
        void runTurn(deps.conversation, { sessionId: id, text }).catch((error: unknown) => {
          console.error("turn failed", error);
        });
        return json({ accepted: true }, 202);
      }
    }

    if (request.method === "GET") return serveStatic(deps, path);
    return json({ error: "not_found" }, 404);
  };
}
