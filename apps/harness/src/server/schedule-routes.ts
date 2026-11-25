import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { EventLog } from "../events/log";
import {
  CreateScheduleBindingSchema,
  UpdateScheduleBindingSchema,
} from "../workflows/workflow-types";
import { WorkflowError, getWorkflow } from "../workflows/workflow-store";
import {
  bindingRuns,
  createBinding,
  deleteBinding,
  getBinding,
  listBindingViews,
  runBindingNow,
  updateBinding,
} from "../scheduler/schedule-store";
import { cancelRun } from "../surfaces/work/cancel";
import { getRun } from "../surfaces/work/runner";
import { collectionRefusal } from "./workflow-routes";

export type ScheduleRouteDeps = {
  readonly db: Database;
  readonly events: EventLog;
};

function json(bodyValue: unknown, status = 200): Response {
  return new Response(JSON.stringify(bodyValue), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function invalid(error: { readonly issues: unknown }): Response {
  return json({ error: "invalid_schedule", issues: error.issues }, 422);
}

const STATUS: Record<string, number> = {
  workflow_not_found: 404,
  schedule_not_found: 404,
  invalid_params: 422,
  workflow_depth_exceeded: 409,
};

function fail(error: unknown): Response {
  if (error instanceof WorkflowError) {
    return json({ error: error.code, detail: error.detail }, STATUS[error.code] ?? 500);
  }
  return json(
    {
      error: "schedule_request_failed",
      detail: error instanceof Error ? error.message : "unknown",
    },
    500,
  );
}

const RequestBody = z.record(z.string(), z.unknown());

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const parsed: unknown = await request.json().catch(() => null);
  return RequestBody.catch({}).parse(parsed);
}

/**
 * Management API for schedule bindings. Returns null for any path it does not
 * own so the main app keeps its routing and auth in front.
 */
export async function handleScheduleRequest(
  request: Request,
  deps: ScheduleRouteDeps,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/schedules") {
    if (request.method === "GET") {
      const workflowId = url.searchParams.get("workflowId") ?? undefined;
      return json({ schedules: listBindingViews(deps.db, workflowId) });
    }
    if (request.method === "POST") {
      const parsed = CreateScheduleBindingSchema.safeParse(await readJson(request));
      if (!parsed.success) return invalid(parsed.error);
      const workflow = getWorkflow(deps.db, parsed.data.workflowId);
      if (!workflow) return json({ error: "workflow_not_found" }, 404);
      const refusal = collectionRefusal(deps.db, workflow.executor);
      if (refusal) return refusal;
      try {
        return json(createBinding(deps.db, parsed.data, Date.now(), deps.events), 201);
      } catch (error) {
        return fail(error);
      }
    }
    return null;
  }

  const cancelMatch = /^\/api\/runs\/([^/]+)\/cancel$/.exec(path);
  if (cancelMatch && request.method === "POST") {
    const runId = cancelMatch[1] ?? "";
    const result = cancelRun(deps, runId);
    if (!result) return json({ error: "run_not_found" }, 404);
    return json({ run: getRun(deps.db, runId), cancelled: result.changed });
  }

  const scheduleMatch = /^\/api\/schedules\/([^/]+)(?:\/(run|runs))?$/.exec(path);
  if (!scheduleMatch) return null;
  const id = scheduleMatch[1] ?? "";
  const sub = scheduleMatch[2];

  if (sub === "run" && request.method === "POST") {
    const body = await readJson(request);
    const args = z.record(z.string(), z.unknown()).optional().catch(undefined).parse(body["args"]);
    if (!getBinding(deps.db, id)) return json({ error: "schedule_not_found" }, 404);
    try {
      const queued = runBindingNow(deps, id, args === undefined ? {} : { args });
      if (!queued) return json({ error: "schedule_not_found" }, 404);
      return json(
        { run: queued.run, occurrence: { scheduledFor: queued.scheduledFor, manual: true } },
        201,
      );
    } catch (error) {
      return fail(error);
    }
  }

  if (sub === "runs" && request.method === "GET") {
    const runs = bindingRuns(deps.db, id);
    if (!runs) return json({ error: "schedule_not_found" }, 404);
    return json({ runs });
  }

  if (sub === undefined && request.method === "GET") {
    const binding = getBinding(deps.db, id);
    if (!binding) return json({ error: "schedule_not_found" }, 404);
    return json({ schedule: binding });
  }

  if (sub === undefined && request.method === "PATCH") {
    const parsed = UpdateScheduleBindingSchema.safeParse(await readJson(request));
    if (!parsed.success) return invalid(parsed.error);
    try {
      const updated = updateBinding(deps.db, id, parsed.data, Date.now(), deps.events);
      if (!updated) return json({ error: "schedule_not_found" }, 404);
      return json(updated);
    } catch (error) {
      return fail(error);
    }
  }

  if (sub === undefined && request.method === "DELETE") {
    if (!deleteBinding(deps.db, id, deps.events)) return json({ error: "schedule_not_found" }, 404);
    return json({ deleted: true, id });
  }

  return null;
}
