// allow: SIZE_OK — authenticated HTTP dispatch is one ordered route boundary.
import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { EventLog } from "../events/log";
import { latestAgentBriefing } from "../workflows/briefing-store";
import { handleWhiteboardRequest } from "./whiteboard-routes";
import type { WhiteboardStore } from "../whiteboard/types";
import { enqueueWorkflowRun } from "../workflows/workflow-run";
import { BRIEFING_WORKFLOW_ID } from "../workflows/system-workflows";
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
  getLeaf,
  pathEntries,
  regeneratePoint,
  searchSessions,
  setLeaf,
  siblings,
} from "../core/tree";
import type { Conversation } from "../surfaces/conversation/surface";
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
import { handleWorkflowRequest } from "./workflow-routes";
import { handleKnowledgeRequest } from "./knowledge-routes";
import { addSubscription, pushConfigured, sendPush, type PushConfig } from "../scheduler/push";
import { readModelPriority, type ModelRouteSummary } from "../providers/settings";
import { handleProviderRequest } from "./provider-routes";
import type { ProviderStore } from "../providers/store";

export type AppDeps = {
  readonly db: Database;
  readonly events: EventLog;
  readonly conversation: Conversation;
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
  /** Public route metadata for the settings screen: never a key or custom header. */
  readonly modelRoutes: readonly ModelRouteSummary[];
  /** The owner's providers and routing chain; absent only in lightweight fixtures. */
  readonly providers?: ProviderStore;
  /** Real apps always provide it; lightweight legacy route fixtures may not. */
  readonly whiteboard?: WhiteboardStore;
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

/**
 * The five tab paths are the client's own routes: the shell is served for them so a
 * reload or a shared link lands on the same tab. The list lives here because the
 * server must not depend on the web build to know its own routes; web/src/routes.ts
 * mirrors it and tests/router-contract.test.ts keeps the two equal.
 */
import { TAB_ROUTE } from "./auth";
export { TAB_ROUTE };
const PAGES = "text/html; charset=utf-8";

async function serveFile(deps: AppDeps, file: string, type: string): Promise<Response | null> {
  for (const root of [deps.webRoot, `${deps.webRoot}/assets`]) {
    const handle = Bun.file(`${root}/${file}`);
    if (await handle.exists())
      return new Response(handle, {
        // The shell is never stored: a browser always asks which build is current.
        headers: {
          "content-type": type,
          "cache-control": file === "index.html" ? "no-store" : "no-cache",
        },
      });
  }
  return null;
}

async function serveStatic(deps: AppDeps, pathname: string): Promise<Response> {
  const page = pathname === "/" || TAB_ROUTE.test(pathname);
  const file = page ? "index.html" : pathname.replace(/^\/+/, "");
  if (file.includes("..")) return new Response("not found", { status: 404 });
  const type = file.endsWith(".js")
    ? "text/javascript; charset=utf-8"
    : file.endsWith(".css")
      ? "text/css; charset=utf-8"
      : PAGES;
  const served = await serveFile(deps, file, type);
  if (served) return served;
  return new Response("client build missing: run `bun run build:web`", { status: 404 });
}

export function createApp(deps: AppDeps): (request: Request) => Promise<Response> {
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

    if (path === "/") {
      return new Response(null, {
        status: 302,
        headers: { location: "/chat", "cache-control": "no-store" },
      });
    }

    if (path === "/api/health") return json({ ok: true, lastSeq: deps.events.lastSeq() });

    if (path === "/api/settings/models" && deps.providers === undefined) {
      if (request.method === "GET")
        return json({
          routes: deps.modelRoutes,
          priority: readModelPriority(deps.db, deps.modelRoutes),
        });
      return json({ error: "method_not_allowed" }, 405);
    }

    if (deps.providers !== undefined) {
      const providerResponse = await handleProviderRequest(request, {
        db: deps.db,
        providers: deps.providers,
      });
      if (providerResponse) return providerResponse;
    }

    const whiteboard = deps.whiteboard;
    if (whiteboard) {
      const whiteboardResponse = await handleWhiteboardRequest(request, { whiteboard });
      if (whiteboardResponse) return whiteboardResponse;
    }

    const knowledgeResponse = await handleKnowledgeRequest(request, {
      db: deps.db,
      filesRoot: deps.filesRoot ?? `${deps.webRoot}/../files`,
      maxUploadBytes: deps.maxUploadBytes ?? 10 * 1024 * 1024,
    });
    if (knowledgeResponse) return knowledgeResponse;

    const accountResponse = await handleAccountRequest(request, deps);
    if (accountResponse) return accountResponse;
    const workflowResponse = await handleWorkflowRequest(request, deps);
    if (workflowResponse) return workflowResponse;
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
      return json(latestAgentBriefing(deps.db));

    if (path === "/api/briefings/run" && request.method === "POST") {
      const prepared = enqueueWorkflowRun(deps, BRIEFING_WORKFLOW_ID, { triggerKind: "manual" });
      return json(
        {
          run: prepared.run,
          workflow: { id: prepared.workflow.id, title: prepared.workflow.title },
        },
        201,
      );
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
          deps.conversation.send(sessionId, text, {
            appendUser: false,
            parentId: result.entry.id,
          });
          return json({ entryId: result.entry.id }, 202);
        }
        if (action === "regenerate") {
          const point = regeneratePoint(deps.db, { sessionId, entryId });
          deps.conversation.send(sessionId, point.userText, {
            appendUser: false,
            parentId: point.parentId,
          });
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

    /**
     * One reply entry can carry edit, regenerate and fork at once. The view asks for
     * `regenerate` when the reply sits under the newest user message; a reply on an
     * older point offers fork only, which is what the controls under it should say.
     */
    const actionsMatch = /^\/api\/sessions\/([^/]+)\/entries\/([^/]+)\/actions$/.exec(path);
    if (actionsMatch && request.method === "GET") {
      const sessionId = actionsMatch[1] ?? "";
      const entryId = actionsMatch[2] ?? "";
      if (!getSession(deps.db, sessionId)) return json({ error: "session_not_found" }, 404);
      const candidates = pathEntries(deps.db, sessionId);
      const entry = candidates.find((candidate) => candidate.id === entryId);
      if (!entry) return json({ error: "entry_not_found" }, 404);
      const leaf = getLeaf(deps.db, sessionId);
      const onActiveBranch = candidates.some(
        (candidate) => candidate.id === leaf && candidate.parentId === entry.id,
      );
      return json({
        actions:
          entry.role === "user" ? ["edit", "regenerate"] : onActiveBranch ? ["regenerate"] : [],
        canFork: true,
      });
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

    /**
     * The conversation queue: what was typed while a turn was answering. It is read
     * and edited apart from the transcript, so a queued message never looks answered.
     */
    const queueMatch = /^\/api\/sessions\/([^/]+)\/queue(?:\/([^/]+)|\/(resume))?$/.exec(path);
    if (queueMatch) {
      const sessionId = queueMatch[1] ?? "";
      if (!getSession(deps.db, sessionId)) return json({ error: "session_not_found" }, 404);
      const queueId = queueMatch[2];
      if (queueId === undefined && queueMatch[3] === undefined && request.method === "GET") {
        return json(deps.conversation.queue(sessionId));
      }
      if (queueMatch[3] === "resume" && request.method === "POST") {
        const outcome = deps.conversation.resume(sessionId);
        return json({ resumed: true, ...outcome }, outcome.drained ? 202 : 200);
      }
      if (queueId !== undefined && request.method === "DELETE") {
        const removed = deps.conversation.cancelQueued(sessionId, queueId);
        if (!removed) return json({ error: "queue_item_not_found" }, 404);
        return json({ cancelled: true });
      }
      return json({ error: "method_not_allowed" }, 405);
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
        const outcome = deps.conversation.send(id, text);
        return json(outcome, 202);
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
        deps.conversation.discard(id);
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
