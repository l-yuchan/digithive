import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { EventLog } from "../events/log";
import {
  createSession,
  getSession,
  listSessions,
  renameSession,
  softDeleteSession,
} from "../core/sessions";
import {
  deepestDescendant,
  editUserMessage,
  forkSession,
  pathEntries,
  regeneratePoint,
  searchSessions,
  setLeaf,
  siblings,
} from "../core/tree";
import { runTurn } from "../surfaces/conversation/loop";
import type { ConversationDeps } from "../surfaces/conversation/loop";
import {
  decideApproval,
  enqueueRun,
  getRun,
  listRuns,
  validateDelegation,
  withApprovals,
  type WorkDeps,
} from "../surfaces/work/runner";
import {
  COOKIE_NAME,
  checkPassphrase,
  isPublicRoute,
  issueCookie,
  readCookie,
  verifyCookie,
  type AuthConfig,
} from "./auth";
import type { GoogleDeps } from "../integrations/google";
import type { CanvasConfig } from "../integrations/canvas";
import { listAccounts } from "../integrations/accounts";
import { handleAccountRequest } from "./account-routes";
import { handleScheduleRequest } from "./schedule-routes";
import { handleKnowledgeRequest } from "./knowledge-routes";
import { addSubscription, pushConfigured, sendPush, type PushConfig } from "../scheduler/push";
import { latestBriefing, runBriefing } from "../scheduler/compose";

export type AppDeps = {
  readonly db: Database;
  readonly events: EventLog;
  readonly conversation: ConversationDeps;
  readonly work: WorkDeps;
  readonly google: GoogleDeps;
  readonly canvas: {
    readonly db: Database;
    readonly events: EventLog;
    readonly config: CanvasConfig;
  };
  readonly vapid: PushConfig;
  readonly webRoot: string;
  /** The build the served web bundle was made from; browsers reload when it changes. */
  readonly buildId: string;
  readonly filesRoot?: string;
  readonly maxUploadBytes?: number;
  readonly auth: AuthConfig;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Live session events. The connection opens with a snapshot of the persisted state
 * and then carries only new events, so a reconnect never replays old deltas over
 * an answer that is already on screen. Partial assistant text is persisted while
 * it streams (see the conversation loop), so the snapshot is current even
 * mid-turn.
 */
function sse(request: Request, deps: AppDeps, sessionId: string | null): Response {
  const encoder = new TextEncoder();
  let lastWritten = 0;
  let cleanup: (() => void) | undefined;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: {
        seq: number;
        kind: string;
        payload: unknown;
        sessionId: string | null;
      }) => {
        if (event.seq <= lastWritten) return;
        if (sessionId && event.sessionId !== sessionId) return;
        lastWritten = event.seq;
        controller.enqueue(
          encoder.encode(
            `id: ${event.seq}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`,
          ),
        );
      };
      const snapshot = {
        sessions: listSessions(deps.db),
        entries: sessionId ? withBranches(deps.db, sessionId) : [],
        lastSeq: deps.events.lastSeq(),
      };
      controller.enqueue(encoder.encode(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`));
      // The snapshot already carries every event up to lastSeq; replaying history
      // would append the same text twice.
      lastWritten = snapshot.lastSeq;

      const unsubscribe = deps.events.subscribe(send, lastWritten);
      const ping = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          cleanup?.();
        }
      }, 10_000);
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
      return new Response(handle, {
        // The shell is never stored: a browser always asks which build is current.
        headers: {
          "content-type": type,
          "cache-control": file === "index.html" ? "no-store" : "no-cache",
        },
      });
    }
  }
  return new Response("client build missing: run `bun run build:web`", { status: 404 });
}

export function createApp(deps: AppDeps): (request: Request) => Promise<Response> {
  const start = (
    sessionId: string,
    text: string,
    extra: { appendUser?: boolean; parentId?: string | null } = {},
  ) => {
    void runTurn(deps.conversation, { sessionId, text, ...extra }).catch((error: unknown) => {
      console.error("turn failed", error);
    });
  };

  return async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/session") {
      const authenticated = verifyCookie(
        deps.auth,
        readCookie(request.headers.get("cookie"), COOKIE_NAME),
      );
      return json({ authenticated, authRequired: deps.auth.passphrase.length > 0 });
    }
    if (path === "/api/login" && request.method === "POST") {
      const raw = z
        .object({ passphrase: z.unknown().optional() })
        .catch({})
        .parse(await request.json().catch(() => ({})));
      const candidate = typeof raw.passphrase === "string" ? raw.passphrase : "";
      if (!checkPassphrase(deps.auth, candidate)) return json({ error: "invalid_passphrase" }, 401);
      const secure = url.protocol === "https:" ? "; Secure" : "";
      return new Response(JSON.stringify({ authenticated: true }), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "set-cookie": `${COOKIE_NAME}=${issueCookie(deps.auth)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}${secure}`,
        },
      });
    }
    if (path === "/api/logout" && request.method === "POST") {
      return new Response(JSON.stringify({ authenticated: false }), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "set-cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
        },
      });
    }

    if (!isPublicRoute(path, request.method)) {
      const authenticated = verifyCookie(
        deps.auth,
        readCookie(request.headers.get("cookie"), COOKIE_NAME),
      );
      if (!authenticated) return json({ error: "unauthenticated" }, 401);
    }

    if (path === "/api/health") return json({ ok: true, lastSeq: deps.events.lastSeq() });
    const knowledgeResponse = await handleKnowledgeRequest(request, {
      db: deps.db,
      filesRoot: deps.filesRoot ?? `${deps.webRoot}/../files`,
      maxUploadBytes: deps.maxUploadBytes ?? 10 * 1024 * 1024,
    });
    if (knowledgeResponse) return knowledgeResponse;

    const accountResponse = await handleAccountRequest(request, deps);
    if (accountResponse) return accountResponse;
    const scheduleResponse = await handleScheduleRequest(request, deps);
    if (scheduleResponse) return scheduleResponse;

    if (path === "/api/connections" && request.method === "GET") {
      return json({
        googleConnected: listAccounts(deps.db, {
          canvasConfigured:
            deps.canvas.config.baseUrl.length > 0 && deps.canvas.config.token.length > 0,
        }).some((account) => account.provider === "google" && account.connected),
        canvasConfigured:
          deps.canvas.config.baseUrl.length > 0 && deps.canvas.config.token.length > 0,
        pushConfigured: pushConfigured(deps.vapid),
      });
    }

    if (path === "/api/push/key" && request.method === "GET")
      return json({ publicKey: deps.vapid.publicKey });

    if (path === "/api/push/subscribe" && request.method === "POST") {
      const raw = z
        .union([z.object({ subscription: z.unknown().optional() }), z.null()])
        .catch(null)
        .parse(await request.json().catch(() => null));
      try {
        return json(addSubscription(deps.db, raw?.subscription));
      } catch (error) {
        return json(
          { error: error instanceof Error ? error.message : "invalid_subscription" },
          422,
        );
      }
    }

    if (path === "/api/push/test" && request.method === "POST") {
      const outcome = await sendPush(deps.db, deps.vapid, {
        title: "digithive 알림 테스트",
        body: "알림이 도착하면 정상입니다.",
      });
      return json(outcome);
    }

    if (path === "/api/briefings/latest" && request.method === "GET")
      return json(latestBriefing(deps.db));

    if (path === "/api/briefings/run" && request.method === "POST") {
      const result = await runBriefing(
        {
          db: deps.db,
          events: deps.events,
          push: async (payload) => {
            const outcome = await sendPush(deps.db, deps.vapid, payload);
            return {
              ok: outcome.sent > 0,
              ...(outcome.sent > 0 ? {} : { error: outcome.errors.join(",") || "no_device" }),
            };
          },
        },
        true,
      );
      return json(result);
    }

    if (path === "/api/runs") {
      if (request.method === "GET") {
        const filters = {
          query: url.searchParams.get("q") ?? "",
          status: url.searchParams.get("status") ?? "",
          origin: url.searchParams.get("origin") ?? "",
        };
        return json({ runs: withApprovals(deps.db, listRuns(deps.db, filters)) });
      }
    }

    const runMatch = /^\/api\/runs\/([^/]+)(?:\/(events|delegate))?(?:\/approvals\/([^/]+))?$/.exec(
      path,
    );
    if (runMatch) {
      const runId = runMatch[1] ?? "";
      const run = getRun(deps.db, runId);
      if (!run) return json({ error: "run_not_found" }, 404);

      if (runMatch[3] && request.method === "POST") {
        const raw = z
          .union([z.object({ decision: z.unknown().optional() }), z.null()])
          .catch(null)
          .parse(await request.json().catch(() => null));
        const decision =
          raw?.decision === "approve" ? "approve" : raw?.decision === "reject" ? "reject" : null;
        if (!decision) return json({ error: "invalid_decision" }, 422);
        try {
          return json(
            decideApproval(
              { db: deps.db, events: deps.events },
              { runId, approvalId: runMatch[3], decision },
            ),
          );
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : "failed" }, 409);
        }
      }

      if (runMatch[2] === "events" && request.method === "GET") {
        const after = Number(url.searchParams.get("after") ?? "0");
        const rows = deps.db
          .query(
            "SELECT seq, run_id, session_id, kind, payload_json, created_at FROM events WHERE run_id = ? AND seq > ? ORDER BY seq",
          )
          .all(runId, Number.isFinite(after) ? after : 0);
        return json({ events: rows });
      }

      if (runMatch[2] === "delegate" && request.method === "POST") {
        const raw = z
          .record(z.string(), z.unknown())
          .catch({})
          .parse(await request.json().catch(() => ({})));
        const budget = z
          .union([
            z.object({ maxMicroUsd: z.unknown().optional(), maxToolCalls: z.unknown().optional() }),
            z.undefined(),
          ])
          .catch(undefined)
          .parse(raw["budget"]);
        const fields = {
          goal: typeof raw["goal"] === "string" ? raw["goal"] : "",
          inputRefs: Array.isArray(raw["inputRefs"])
            ? z.array(z.string()).catch([]).parse(raw["inputRefs"])
            : [],
          permissionProfile:
            typeof raw["permissionProfile"] === "string" ? raw["permissionProfile"] : "",
          budget: {
            maxMicroUsd: Number(budget?.maxMicroUsd ?? Number.NaN),
            maxToolCalls: Number(budget?.maxToolCalls ?? Number.NaN),
          },
          completionCondition:
            typeof raw["completionCondition"] === "string" ? raw["completionCondition"] : "",
        };
        const missing = validateDelegation(fields);
        if (missing.length > 0) return json({ error: "incomplete_delegation", missing }, 422);
        const child = enqueueRun(deps.db, deps.events, {
          goal: fields.goal,
          origin: "delegation",
          sessionId: run.sessionId,
          parentRunId: run.id,
          budget: fields.budget,
          delegation: fields,
        });
        return json({ child, fields }, 201);
      }

      if (runMatch[2] === undefined && request.method === "GET")
        return json(withApprovals(deps.db, [run])[0]);
    }

    if (path === "/api/events" && request.method === "GET") {
      return sse(request, deps, url.searchParams.get("session"));
    }

    if (path === "/api/version") return json({ build: deps.buildId });

    if (path === "/api/sessions") {
      if (request.method === "GET") {
        const query = url.searchParams.get("q");
        if (query && query.trim().length > 0)
          return json({ sessions: searchSessions(deps.db, query) });
        return json({ sessions: listSessions(deps.db) });
      }
      if (request.method === "POST") {
        const raw = z
          .object({ title: z.unknown().optional() })
          .catch({})
          .parse(await request.json().catch(() => ({})));
        const title =
          typeof raw.title === "string" && raw.title.trim().length > 0
            ? raw.title.trim()
            : "새 대화";
        const session = createSession(deps.db, title);
        deps.events.append({
          kind: "session.created",
          sessionId: session.id,
          payload: { id: session.id, title: session.title },
        });
        return json(session, 201);
      }
    }

    const entryMatch = /^\/api\/sessions\/([^/]+)\/entries\/([^/]+)\/(edit|regenerate|leaf)$/.exec(
      path,
    );
    if (entryMatch && request.method === "POST") {
      const sessionId = entryMatch[1] ?? "";
      const entryId = entryMatch[2] ?? "";
      const action = entryMatch[3];
      if (!getSession(deps.db, sessionId)) return json({ error: "session_not_found" }, 404);
      try {
        if (action === "edit") {
          const raw = z
            .union([z.object({ text: z.unknown().optional() }), z.null()])
            .catch(null)
            .parse(await request.json().catch(() => null));
          const text = typeof raw?.text === "string" ? raw.text.trim() : "";
          if (text.length === 0 || text.length > 8_000) return json({ error: "invalid_text" }, 422);
          const result = editUserMessage(deps.db, { sessionId, entryId, text });
          deps.events.append({
            kind: "context.edited",
            sessionId,
            payload: { entryId: result.entry.id, replaced: entryId },
          });
          start(sessionId, text, { appendUser: false, parentId: result.entry.id });
          return json({ entryId: result.entry.id }, 202);
        }
        if (action === "regenerate") {
          const point = regeneratePoint(deps.db, { sessionId, entryId });
          start(sessionId, point.userText, { appendUser: false, parentId: point.parentId });
          return json({ parentId: point.parentId }, 202);
        }
        const raw = z
          .union([z.object({ entryId: z.unknown().optional() }), z.null()])
          .catch(null)
          .parse(await request.json().catch(() => null));
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
      const raw = z
        .union([
          z.object({ entryId: z.unknown().optional(), title: z.unknown().optional() }),
          z.null(),
        ])
        .catch(null)
        .parse(await request.json().catch(() => null));
      const entryId = typeof raw?.entryId === "string" ? raw.entryId : "";
      const title = typeof raw?.title === "string" ? raw.title : "분기 대화";
      try {
        const forked = forkSession(deps.db, { sessionId, entryId, title });
        deps.events.append({
          kind: "session.created",
          sessionId: forked.sessionId,
          payload: { id: forked.sessionId, title },
        });
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
        const raw = z
          .union([z.object({ text: z.unknown().optional() }), z.null()])
          .catch(null)
          .parse(await request.json().catch(() => null));
        const text = typeof raw?.text === "string" ? raw.text.trim() : "";
        if (text.length === 0 || text.length > 8_000) return json({ error: "invalid_text" }, 422);
        start(id, text);
        return json({ accepted: true }, 202);
      }
      if (sessionMatch[2] === undefined && request.method === "PATCH") {
        const raw = z
          .union([z.object({ title: z.unknown().optional() }), z.null()])
          .catch(null)
          .parse(await request.json().catch(() => null));
        const title = typeof raw?.title === "string" ? raw.title : "";
        const renamed = renameSession(deps.db, id, title);
        if (!renamed) return json({ error: "invalid_title" }, 422);
        deps.events.append({
          kind: "session.renamed",
          sessionId: id,
          payload: { title: renamed.title },
        });
        return json(renamed);
      }
      if (sessionMatch[2] === undefined && request.method === "DELETE") {
        const result = softDeleteSession(deps.db, id);
        deps.events.append({
          kind: "session.deleted",
          sessionId: id,
          payload: { cancelledRuns: result.cancelledRuns },
        });
        return json({ deleted: true, cancelledRuns: result.cancelledRuns });
      }
    }

    if (request.method === "GET") return serveStatic(deps, path);
    return json({ error: "not_found" }, 404);
  };
}
