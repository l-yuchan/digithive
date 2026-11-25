import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { EventLog } from "../events/log";
import { enqueueRun, getRun, type RunRow } from "../surfaces/work/runner";
import {
  CreateScheduleSchema,
  SCHEDULE_SELECT,
  UpdateScheduleSchema,
  nextFor,
  readSchedule,
  rowToSchedule,
  type CreateScheduleInput,
  type LastRun,
  type Schedule,
  type ScheduleRow,
  type ScheduleView,
  type UpdateScheduleInput,
} from "./schedule-types";

export function getSchedule(db: Database, id: string): Schedule | null {
  const row = readSchedule(db, id);
  return row ? rowToSchedule(row) : null;
}

function lastRunFor(db: Database, scheduleId: string): LastRun | null {
  const row = db
    .query<
      { run_id: string; status: string; result_json: string | null; settled_at: string | null },
      SQLQueryBindings[]
    >(
      `SELECT o.run_id AS run_id, r.status AS status, r.result_json AS result_json, r.settled_at AS settled_at
         FROM schedule_occurrences o JOIN runs r ON r.id = o.run_id
        WHERE o.schedule_id = ? ORDER BY o.created_at DESC, r.created_at DESC LIMIT 1`,
    )
    .get(scheduleId);
  if (!row) return null;
  return {
    id: row.run_id,
    status: row.status,
    resultJson: row.result_json,
    settledAt: row.settled_at,
  };
}

export function listSchedules(db: Database): ScheduleView[] {
  return db
    .query<ScheduleRow, SQLQueryBindings[]>(`${SCHEDULE_SELECT} ORDER BY created_at`)
    .all()
    .map((row) => {
      const schedule = rowToSchedule(row);
      return { ...schedule, lastRun: lastRunFor(db, schedule.id) };
    });
}

export function createSchedule(
  db: Database,
  input: CreateScheduleInput,
  now = Date.now(),
  events?: EventLog,
): Schedule {
  const parsed = CreateScheduleSchema.parse(input);
  const id = crypto.randomUUID();
  const iso = new Date(now).toISOString();
  db.query(
    `INSERT INTO schedules (id,title,instruction,enabled,trigger_json,executor_json,timeout_seconds,next_run_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    parsed.title,
    parsed.instruction,
    parsed.enabled ? 1 : 0,
    JSON.stringify(parsed.trigger),
    JSON.stringify(parsed.executor),
    parsed.timeoutSeconds,
    nextFor(parsed.trigger, parsed.enabled, now),
    iso,
    iso,
  );
  events?.append({ kind: "schedule.created", payload: { id, title: parsed.title }, now });
  const created = getSchedule(db, id);
  if (!created) throw new Error("schedule_not_created");
  return created;
}

export function updateSchedule(
  db: Database,
  id: string,
  patch: UpdateScheduleInput,
  now = Date.now(),
  events?: EventLog,
): Schedule | null {
  const existing = readSchedule(db, id);
  if (!existing) return null;
  const current = rowToSchedule(existing);
  const parsed = UpdateScheduleSchema.parse(patch);
  const merged = {
    title: parsed.title ?? current.title,
    instruction: parsed.instruction ?? current.instruction,
    enabled: parsed.enabled ?? current.enabled,
    trigger: parsed.trigger ?? current.trigger,
    executor: parsed.executor ?? current.executor,
    timeoutSeconds: parsed.timeoutSeconds ?? current.timeoutSeconds,
  };
  const triggerChanged =
    parsed.trigger !== undefined &&
    JSON.stringify(parsed.trigger) !== JSON.stringify(current.trigger);
  const shouldRecompute =
    triggerChanged || (merged.enabled && !current.enabled) || (!merged.enabled && current.enabled);
  const nextRunAt = shouldRecompute
    ? nextFor(merged.trigger, merged.enabled, now)
    : merged.enabled
      ? current.nextRunAt
      : null;
  db.query(
    `UPDATE schedules SET title=?,instruction=?,enabled=?,trigger_json=?,executor_json=?,timeout_seconds=?,next_run_at=?,updated_at=? WHERE id=?`,
  ).run(
    merged.title,
    merged.instruction,
    merged.enabled ? 1 : 0,
    JSON.stringify(merged.trigger),
    JSON.stringify(merged.executor),
    merged.timeoutSeconds,
    nextRunAt,
    new Date(now).toISOString(),
    id,
  );
  events?.append({ kind: "schedule.updated", payload: { id, title: merged.title }, now });
  return getSchedule(db, id);
}

/** Deletes the definition; occurrences and their runs survive with a null link. */
export function deleteSchedule(
  db: Database,
  id: string,
  events?: EventLog,
  now = Date.now(),
): boolean {
  return db
    .transaction(() => {
      const existing = readSchedule(db, id);
      if (!existing) return false;
      db.query("UPDATE schedule_occurrences SET schedule_id = NULL WHERE schedule_id = ?").run(id);
      db.query("DELETE FROM schedules WHERE id = ?").run(id);
      events?.append({ kind: "schedule.deleted", payload: { id }, now });
      return true;
    })
    .immediate();
}

export function insertOccurrence(
  db: Database,
  input: {
    readonly schedule: Schedule;
    readonly scheduledFor: string;
    readonly runId: string;
    readonly manual: boolean;
    readonly now: number;
  },
  events?: EventLog,
): void {
  db.query(
    `INSERT INTO schedule_occurrences (id,schedule_id,schedule_title,scheduled_for,run_id,manual,created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(
    crypto.randomUUID(),
    input.schedule.id,
    input.schedule.title,
    input.scheduledFor,
    input.runId,
    input.manual ? 1 : 0,
    new Date(input.now).toISOString(),
  );
  events?.append({
    kind: "schedule.run",
    runId: input.runId,
    payload: {
      id: input.schedule.id,
      runId: input.runId,
      scheduledFor: input.scheduledFor,
      manual: input.manual,
    },
    now: input.now,
  });
}

function bumpOccurrenceTime(db: Database, scheduleId: string, start: number): string {
  let now = start;
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const iso = new Date(now).toISOString();
    const row = db
      .query<{ id: string }, SQLQueryBindings[]>(
        "SELECT id FROM schedule_occurrences WHERE schedule_id = ? AND scheduled_for = ?",
      )
      .get(scheduleId, iso);
    if (!row) return iso;
    now += 1;
  }
  throw new Error("occurrence_time_conflict");
}

/**
 * Explicit manual occurrence. It never changes `next_run_at`, and it enqueues a
 * normal work run: the scheduler never executes work inside the request.
 */
export function runScheduleNow(
  deps: { readonly db: Database; readonly events: EventLog },
  id: string,
  now = Date.now(),
): { run: RunRow; scheduledFor: string } | null {
  return deps.db
    .transaction(() => {
      const row = readSchedule(deps.db, id);
      if (!row) return null;
      const schedule = rowToSchedule(row);
      const scheduledFor = bumpOccurrenceTime(deps.db, id, now);
      const run = enqueueRun(deps.db, deps.events, {
        goal: schedule.instruction,
        origin: "work",
        executor: schedule.executor,
        timeoutSeconds: schedule.timeoutSeconds,
        now,
      });
      insertOccurrence(
        deps.db,
        { schedule, scheduledFor, runId: run.id, manual: true, now },
        deps.events,
      );
      return { run, scheduledFor };
    })
    .immediate();
}

export type ScheduleRun = RunRow & {
  readonly scheduledFor: string;
  readonly manual: boolean;
};

export function scheduleRuns(db: Database, scheduleId: string): ScheduleRun[] | null {
  if (!readSchedule(db, scheduleId)) return null;
  const rows = db
    .query<{ run_id: string; scheduled_for: string; manual: number }, SQLQueryBindings[]>(
      "SELECT run_id, scheduled_for, manual FROM schedule_occurrences WHERE schedule_id = ? ORDER BY created_at DESC",
    )
    .all(scheduleId);
  const runs: ScheduleRun[] = [];
  for (const row of rows) {
    const run = getRun(db, row.run_id);
    if (run) runs.push({ ...run, scheduledFor: row.scheduled_for, manual: row.manual === 1 });
  }
  return runs;
}
