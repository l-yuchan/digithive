import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { EventLog } from "../events/log";
import { enqueueRun } from "../surfaces/work/runner";
import { insertOccurrence } from "./schedule-store";
import {
  SCHEDULE_SELECT,
  nextFor,
  readSchedule,
  rowToSchedule,
  type ScheduleRow,
} from "./schedule-types";
import { latestDueAtOrBefore } from "./triggers";

export type DispatchStats = {
  readonly enqueued: number;
  readonly skipped: number;
};

const ACTIVE = "('queued','running','awaiting_approval')";

function dispatchOne(
  deps: { readonly db: Database; readonly events: EventLog },
  id: string,
  expectedNext: string,
  now: number,
): "enqueued" | "skipped" {
  return deps.db
    .transaction((): "enqueued" | "skipped" => {
      const row = readSchedule(deps.db, id);
      if (!row || row.enabled !== 1) return "skipped";
      if (row.next_run_at !== expectedNext) return "skipped";
      const schedule = rowToSchedule(row);
      const slot = latestDueAtOrBefore(schedule.trigger, now);
      if (!slot) return "skipped";
      const next = nextFor(schedule.trigger, schedule.enabled, now);
      const advance = () =>
        deps.db
          .query("UPDATE schedules SET next_run_at = ? WHERE id = ? AND next_run_at = ?")
          .run(next, id, expectedNext);

      const active = deps.db
        .query<{ run_id: string }, SQLQueryBindings[]>(
          `SELECT o.run_id AS run_id FROM schedule_occurrences o JOIN runs r ON r.id = o.run_id
            WHERE o.schedule_id = ? AND r.status IN ${ACTIVE} LIMIT 1`,
        )
        .get(id);
      if (active) {
        advance();
        return "skipped";
      }
      const duplicate = deps.db
        .query<{ id: string }, SQLQueryBindings[]>(
          "SELECT id FROM schedule_occurrences WHERE schedule_id = ? AND scheduled_for = ?",
        )
        .get(id, slot.scheduledFor);
      if (duplicate) {
        advance();
        return "skipped";
      }

      const run = enqueueRun(deps.db, deps.events, {
        goal: schedule.instruction,
        origin: "work",
        executor: schedule.executor,
        timeoutSeconds: schedule.timeoutSeconds,
        now,
      });
      insertOccurrence(
        deps.db,
        { schedule, scheduledFor: slot.scheduledFor, runId: run.id, manual: false, now },
        deps.events,
      );
      advance();
      return "enqueued";
    })
    .immediate();
}

/**
 * Initializes a missing deadline and enqueues at most the latest missed slot of
 * every due schedule. It never waits for a run; the worker claims it later.
 */
export function dispatchDueSchedules(
  deps: { readonly db: Database; readonly events: EventLog },
  now = Date.now(),
): DispatchStats {
  let enqueued = 0;
  let skipped = 0;
  const rows = deps.db
    .query<ScheduleRow, SQLQueryBindings[]>(`${SCHEDULE_SELECT} WHERE enabled = 1 ORDER BY created_at`)
    .all();
  for (const row of rows) {
    const schedule = rowToSchedule(row);
    const expected = row.next_run_at;
    if (expected === null) {
      const initialized = nextFor(schedule.trigger, true, now);
      if (initialized === null) {
        skipped += 1;
        continue;
      }
      deps.db
        .query("UPDATE schedules SET next_run_at = ? WHERE id = ? AND next_run_at IS NULL")
        .run(initialized, row.id);
      skipped += 1;
      continue;
    }
    if (Date.parse(expected) > now) continue;
    const outcome = dispatchOne(deps, row.id, expected, now);
    if (outcome === "enqueued") enqueued += 1;
    else skipped += 1;
  }
  return { enqueued, skipped };
}
