import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { EventLog } from "../events/log";
import {
  CreateScheduleSchema,
  UpdateScheduleSchema,
  createSchedule,
  deleteSchedule,
  getSchedule,
  listSchedules,
  runScheduleNow,
  scheduleRuns,
  updateSchedule,
} from "../scheduler/schedules";
import { cancelRun } from "../surfaces/work/cancel";
import { getRun } from "../surfaces/work/runner";
import type { RunExecutor } from "../core/executor";
import { getAccount, isSourceEnabled } from "../integrations/accounts";

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

const RequestBody = z.record(z.string(), z.unknown());

/**
 * Saving a collection schedule is where the owner grants use of that account's
 * information, so a schedule that reads a disabled feature is refused here with
 * the reason instead of silently collecting nothing on every run.
 */
function collectionProblem(db: Database, executor: RunExecutor | undefined): string | null {
  if (!executor || executor.kind !== "builtin" || executor.name !== "sync_sources") return null;
  if (!executor.accountId) return "수집 스케줄은 계정을 골라야 합니다.";
  const account = getAccount(db, executor.accountId);
  if (!account) return `계정 ${executor.accountId} 이(가) 없습니다.`;
  for (const source of executor.sources ?? []) {
    if (!isSourceEnabled(db, account.id, source))
      return `${account.label} 의 ${source} 정보 사용이 꺼져 있습니다. 연결 탭에서 켜거나 이 정보를 수집에서 제외하세요.`;
  }
  return null;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const parsed: unknown = await request.json().catch(() => null);
  return RequestBody.catch({}).parse(parsed);
}

/**
 * Management API for persisted schedules. Returns null for any path it does not
 * own, so the main app can keep its existing routing and auth in front.
 */
export async function handleScheduleRequest(
  request: Request,
  deps: ScheduleRouteDeps,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/schedules") {
    if (request.method === "GET") return json({ schedules: listSchedules(deps.db) });
    if (request.method === "POST") {
      const parsed = CreateScheduleSchema.safeParse(await readJson(request));
      if (!parsed.success) return invalid(parsed.error);
      const problem = collectionProblem(deps.db, parsed.data.executor);
      if (problem) return json({ error: "collection_not_permitted", detail: problem }, 422);
      return json(createSchedule(deps.db, parsed.data, Date.now(), deps.events), 201);
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
    const queued = runScheduleNow(deps, id);
    if (!queued) return json({ error: "schedule_not_found" }, 404);
    return json(
      {
        run: queued.run,
        occurrence: { scheduledFor: queued.scheduledFor, manual: true },
      },
      201,
    );
  }

  if (sub === "runs" && request.method === "GET") {
    const runs = scheduleRuns(deps.db, id);
    if (!runs) return json({ error: "schedule_not_found" }, 404);
    return json({ runs });
  }

  if (sub === undefined && request.method === "PATCH") {
    const parsed = UpdateScheduleSchema.safeParse(await readJson(request));
    if (!parsed.success) return invalid(parsed.error);
    const problem = collectionProblem(deps.db, parsed.data.executor);
    if (problem) return json({ error: "collection_not_permitted", detail: problem }, 422);
    const updated = updateSchedule(deps.db, id, parsed.data, Date.now(), deps.events);
    if (!updated) return json({ error: "schedule_not_found" }, 404);
    return json(updated);
  }

  if (sub === undefined && request.method === "DELETE") {
    if (!getSchedule(deps.db, id)) return json({ error: "schedule_not_found" }, 404);
    deleteSchedule(deps.db, id, deps.events);
    return json({ deleted: true, id });
  }

  return null;
}
