import type { Database } from "bun:sqlite";
import type { EventLog } from "../events/log";
import { createSession, getSession, listSessions, renameSession, softDeleteSession } from "../core/sessions";
import { deepestDescendant, editUserMessage, forkSession, pathEntries, regeneratePoint, searchSessions, setLeaf, siblings } from "../core/tree";
import { runTurn } from "../surfaces/conversation/loop";
import type { ConversationDeps } from "../surfaces/conversation/loop";

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
        entries: sessionId ? withBranches(deps.db, sessionId) : [],
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

/** Active branch only, with sibling counts so the client can offer a branch switcher. */
function withBranches(db: Database, sessionId: string) {
  return pathEntries(db, sessionId).map((entry) => {
    const group = siblings(db, sessionId, entry.id);
    return {
      ...entry,
      siblingCount: group.length,
      siblingIndex: group.findIndex((sibling) => sibling.id === entry.id) + 1,
      siblingIds: group.map((sibling) => sibling.id),
    };
  });
}

async function serveStatic(deps: AppDeps, pathname: string): Promise<Response> {
  const file = pathname === "/" || pathname === "" ? "index.html" : pathname.replace(/^\/+/, "");
  if (file.includes("..")) return new Response("not found", { status: 404 });
  for (const root of [deps.webRoot, `${deps.webRoot}/assets`]) {
    const handle = Bun.file(`${root}/${file}`);
    if (await handle.exists()) {
      const type = file.endsWith(".js")
        ? "text/javascript; charset=utf-8"
        : file.endsWith(".css")
          ? "text/css; charset=utf-8"
          : "text/html; charset=utf-8";
      return new Response(handle, { headers: { "content-type": type, "cache-control": "no-cache" } });
    }
  }
  return new Response("client build missing: run `bun run build:web`", { status: 404 });
}

export function createApp(deps: AppDeps): (request: Request) => Promise<Response> {
  const start = (sessionId: string, text: string, extra: { appendUser?: boolean; parentId?: string | null } = {}) => {
    void runTurn(deps.conversation, { sessionId, text, ...extra }).catch((error: unknown) => {
      console.error("turn failed", error);
    });
  };

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
      if (request.method === "GET") {
        const query = url.searchParams.get("q");
        if (query && query.trim().length > 0) return json({ sessions: searchSessions(deps.db, query) });
        return json({ sessions: listSessions(deps.db) });
      }
      if (request.method === "POST") {
        const raw = (await request.json().catch(() => ({}))) as { title?: unknown };
        const title = typeof raw.title === "string" && raw.title.trim().length > 0 ? raw.title.trim() : "새 대화";
        const session = createSession(deps.db, title);
        deps.events.append({ kind: "session.created", sessionId: session.id, payload: { id: session.id, title: session.title } });
        return json(session, 201);
      }
    }

    const entryMatch = /^\/api\/sessions\/([^/]+)\/entries\/([^/]+)\/(edit|regenerate|leaf)$/.exec(path);
    if (entryMatch && request.method === "POST") {
      const sessionId = entryMatch[1] ?? "";
      const entryId = entryMatch[2] ?? "";
      const action = entryMatch[3];
      if (!getSession(deps.db, sessionId)) return json({ error: "session_not_found" }, 404);
      try {
        if (action === "edit") {
          const raw = (await request.json().catch(() => null)) as { text?: unknown } | null;
          const text = typeof raw?.text === "string" ? raw.text.trim() : "";
          if (text.length === 0 || text.length > 8_000) return json({ error: "invalid_text" }, 422);
          const result = editUserMessage(deps.db, { sessionId, entryId, text });
          deps.events.append({ kind: "context.edited", sessionId, payload: { entryId: result.entry.id, replaced: entryId } });
          start(sessionId, text, { appendUser: false, parentId: result.entry.id });
          return json({ entryId: result.entry.id }, 202);
        }
        if (action === "regenerate") {
          const point = regeneratePoint(deps.db, { sessionId, entryId });
          start(sessionId, point.userText, { appendUser: false, parentId: point.parentId });
          return json({ parentId: point.parentId }, 202);
        }
        const raw = (await request.json().catch(() => null)) as { entryId?: unknown } | null;
        const leaf = typeof raw?.entryId === "string" ? raw.entryId : null;
        if (!leaf) return json({ error: "invalid_leaf" }, 422);
        const target = deepestDescendant(deps.db, sessionId, leaf);
        setLeaf(deps.db, sessionId, target);
        return json({ leaf: target });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "failed" }, 409);
      }
    }

    const forkMatch = /^\/api\/sessions\/([^/]+)\/fork$/.exec(path);
    if (forkMatch && request.method === "POST") {
      const sessionId = forkMatch[1] ?? "";
      const raw = (await request.json().catch(() => null)) as { entryId?: unknown; title?: unknown } | null;
      const entryId = typeof raw?.entryId === "string" ? raw.entryId : "";
      const title = typeof raw?.title === "string" ? raw.title : "분기 대화";
      try {
        const forked = forkSession(deps.db, { sessionId, entryId, title });
        deps.events.append({ kind: "session.created", sessionId: forked.sessionId, payload: { id: forked.sessionId, title } });
        return json(forked, 201);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "failed" }, 409);
      }
    }

    const sessionMatch = /^\/api\/sessions\/([^/]+)(?:\/(entries|messages))?$/.exec(path);
    if (sessionMatch) {
      const id = sessionMatch[1] ?? "";
      const session = getSession(deps.db, id);
      if (!session) return json({ error: "session_not_found" }, 404);

      if (sessionMatch[2] === "entries" && request.method === "GET") {
        return json({ entries: withBranches(deps.db, id) });
      }
      if (sessionMatch[2] === "messages" && request.method === "POST") {
        const raw = (await request.json().catch(() => null)) as { text?: unknown } | null;
        const text = typeof raw?.text === "string" ? raw.text.trim() : "";
        if (text.length === 0 || text.length > 8_000) return json({ error: "invalid_text" }, 422);
        start(id, text);
        return json({ accepted: true }, 202);
      }
      if (sessionMatch[2] === undefined && request.method === "PATCH") {
        const raw = (await request.json().catch(() => null)) as { title?: unknown } | null;
        const title = typeof raw?.title === "string" ? raw.title : "";
        const renamed = renameSession(deps.db, id, title);
        if (!renamed) return json({ error: "invalid_title" }, 422);
        deps.events.append({ kind: "session.renamed", sessionId: id, payload: { title: renamed.title } });
        return json(renamed);
      }
      if (sessionMatch[2] === undefined && request.method === "DELETE") {
        const result = softDeleteSession(deps.db, id);
        deps.events.append({ kind: "session.deleted", sessionId: id, payload: { cancelledRuns: result.cancelledRuns } });
        return json({ deleted: true, cancelledRuns: result.cancelledRuns });
      }
    }

    if (request.method === "GET") return serveStatic(deps, path);
    return json({ error: "not_found" }, 404);
  };
}
