import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { EventLog } from "../events/log";
import { getAccount } from "../integrations/accounts";
import type { RunExecutor } from "../core/executor";
import { COLLECTION_SCRIPT } from "../workflows/workflow-store";
import {
  CreateWorkflowSchema,
  UpdateWorkflowSchema,
  WorkflowSearchSchema,
} from "../workflows/workflow-types";
import {
  WorkflowError,
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  runsForWorkflow,
  updateWorkflow,
  workflowView,
} from "../workflows/workflow-store";
import { searchWorkflowIds } from "../workflows/workflow-search";
import { enqueueWorkflowRun } from "../workflows/workflow-run";

export type WorkflowRouteDeps = {
  readonly db: Database;
  readonly events: EventLog;
};

function json(bodyValue: unknown, status = 200): Response {
  return new Response(JSON.stringify(bodyValue), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const STATUS: Record<string, number> = {
  workflow_not_found: 404,
  schedule_not_found: 404,
  invalid_params: 422,
  schedule_args_invalid: 409,
  schedules_present: 409,
  workflow_depth_exceeded: 409,
  search_query_too_short: 422,
  search_invalid_regex: 422,
  search_invalid_bm25: 422,
};

function fail(error: unknown): Response {
  if (error instanceof WorkflowError) {
    return json({ error: error.code, detail: error.detail }, STATUS[error.code] ?? 500);
  }
  return json(
    {
      error: "workflow_request_failed",
      detail: error instanceof Error ? error.message : "unknown",
    },
    500,
  );
}

function invalid(error: { readonly issues: unknown }): Response {
  return json({ error: "invalid_workflow", issues: error.issues }, 422);
}

const RequestBody = z.record(z.string(), z.unknown());

/**
 * Saving a collection workflow is where the owner grants use of that account's
 * information, so one that names an account that no longer exists is refused here
 * with the reason instead of failing on every run.
 *
 * Which sources the run reads is decided by the script from the account's switches at
 * run time, so there is no stored source list here to go stale: turning a feature off
 * stops the next run by itself.
 */
function collectionProblem(db: Database, executor: RunExecutor | undefined): string | null {
  if (!executor || executor.kind !== "script" || executor.path !== COLLECTION_SCRIPT) return null;
  const accountId = executor.args[0];
  if (!accountId) return "수집 워크플로는 계정 id를 첫 인자로 지정해야 합니다.";
  const account = getAccount(db, accountId);
  if (!account) return `계정 ${accountId} 이(가) 없습니다.`;
  return null;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const parsed: unknown = await request.json().catch(() => null);
  return RequestBody.catch({}).parse(parsed);
}

export function collectionRefusal(
  db: Database,
  executor: RunExecutor | undefined,
): Response | null {
  const problem = collectionProblem(db, executor);
  return problem === null
    ? null
    : json({ error: "collection_not_permitted", detail: problem }, 422);
}

/**
 * Management API for workflow definitions. Returns null for any path it does not
 * own, so the main app keeps its routing and auth in front.
 */
export async function handleWorkflowRequest(
  request: Request,
  deps: WorkflowRouteDeps,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/workflows") {
    if (request.method === "GET") {
      const search = WorkflowSearchSchema.safeParse({
        keyword: url.searchParams.get("keyword") ?? undefined,
        regex: url.searchParams.get("regex") ?? undefined,
        bm25: url.searchParams.get("bm25") ?? undefined,
      });
      if (!search.success) return invalid(search.error);
      try {
        const hits = searchWorkflowIds(deps.db, search.data);
        const workflows = hits
          .map((hit) => {
            const view = workflowView(deps.db, hit.id);
            return view === null ? null : { ...view, score: hit.score };
          })
          .filter((view) => view !== null);
        return json({ workflows });
      } catch (error) {
        return fail(error);
      }
    }
    if (request.method === "POST") {
      const parsed = CreateWorkflowSchema.safeParse(await readJson(request));
      if (!parsed.success) return invalid(parsed.error);
      const refusal = collectionRefusal(deps.db, parsed.data.executor);
      if (refusal) return refusal;
      try {
        return json(createWorkflow(deps.db, parsed.data, Date.now(), deps.events), 201);
      } catch (error) {
        return fail(error);
      }
    }
    return null;
  }

  const match = /^\/api\/workflows\/([^/]+)(?:\/(run|runs))?$/.exec(path);
  if (!match) return null;
  let id: string;
  try {
    id = decodeURIComponent(match[1] ?? "");
  } catch (error) {
    if (error instanceof URIError) return json({ error: "invalid_workflow_id" }, 400);
    throw error;
  }
  const sub = match[2];

  if (sub === "run" && request.method === "POST") {
    const body = await readJson(request);
    // The management endpoint queues by design (the screen shows the run's
    // progress); only the agent tool runs inline. Refuse instead of silently
    // queueing when a caller asks for an immediate run.
    if (body["async"] === false) {
      return json(
        {
          error: "run_not_inline",
          detail: {
            message: "이 HTTP 표면은 실행을 큐에 넣습니다. 즉시 실행은 workflow_run 도구를 쓰세요.",
          },
        },
        422,
      );
    }
    try {
      const prepared = enqueueWorkflowRun(deps, id, {
        args: z.record(z.string(), z.unknown()).catch({}).parse(body["args"]),
        triggerKind: "manual",
      });
      return json(
        {
          run: prepared.run,
          workflow: { id: prepared.workflow.id, title: prepared.workflow.title },
          params: prepared.params,
        },
        201,
      );
    } catch (error) {
      return fail(error);
    }
  }

  if (sub === "runs" && request.method === "GET") {
    if (!getWorkflow(deps.db, id)) return json({ error: "workflow_not_found" }, 404);
    return json({ runs: runsForWorkflow(deps.db, id, 30) });
  }

  if (sub === undefined && request.method === "GET") {
    const view = workflowView(deps.db, id);
    if (!view) return json({ error: "workflow_not_found" }, 404);
    return json({ workflow: view, runs: runsForWorkflow(deps.db, id, 5) });
  }

  if (sub === undefined && request.method === "PATCH") {
    const parsed = UpdateWorkflowSchema.safeParse(await readJson(request));
    if (!parsed.success) return invalid(parsed.error);
    const refusal = collectionRefusal(deps.db, parsed.data.executor);
    if (refusal) return refusal;
    const force = url.searchParams.get("force") === "1";
    try {
      return json(updateWorkflow(deps.db, id, parsed.data, { events: deps.events, force }));
    } catch (error) {
      return fail(error);
    }
  }

  if (sub === undefined && request.method === "DELETE") {
    const cascade = url.searchParams.get("cascade") === "1";
    try {
      return json({
        deleted: true,
        id,
        ...deleteWorkflow(deps.db, id, { cascade, events: deps.events }),
      });
    } catch (error) {
      return fail(error);
    }
  }

  return null;
}
