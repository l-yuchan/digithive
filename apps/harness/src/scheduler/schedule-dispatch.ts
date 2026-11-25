import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { EventLog } from "../events/log";
import { getWorkflow, WorkflowError } from "../workflows/workflow-store";
import { enqueueWorkflowRun } from "../workflows/workflow-run";
import { insertOccurrence } from "./schedule-store";
import { BINDING_SELECT, rowToBinding, type BindingRow } from "./schedule-types";
import { latestDueAtOrBefore, nextDueAfter } from "./triggers";

export type DispatchStats = {
  readonly enqueued: number;
  readonly skipped: number;
  readonly disabled: number;
};

const ACTIVE = "('queued','running','awaiting_approval')";

function nextFor(
  trigger: ReturnType<typeof rowToBinding>["trigger"],
  enabled: boolean,
  now: number,
): string | null {
  if (!enabled) return null;
  const at = nextDueAfter(trigger, now);
  return at === null ? null : new Date(at).toISOString();
}

function dispatchOne(
  deps: { readonly db: Database; readonly events: EventLog },
  id: string,
  expectedNext: string,
  now: number,
): "enqueued" | "skipped" | "disabled" {
  return deps.db
    .transaction((): "enqueued" | "skipped" | "disabled" => {
      const row = deps.db
        .query<BindingRow, SQLQueryBindings[]>(`${BINDING_SELECT} WHERE id = ?`)
        .get(id);
      if (!row || row.enabled !== 1) return "skipped";
      if (row.next_run_at !== expectedNext) return "skipped";
      const binding = rowToBinding(row);
      const workflow = getWorkflow(deps.db, binding.workflowId);
      const slot = latestDueAtOrBefore(binding.trigger, now);
      if (!slot) return "skipped";
      const next = nextFor(binding.trigger, true, now);
      const advance = () =>
        deps.db
          .query("UPDATE schedules SET next_run_at = ? WHERE id = ? AND next_run_at = ?")
          .run(next, id, expectedNext);
      if (!workflow) {
        // The foreign key normally prevents this; a dangling binding would fail on
        // every tick, so it is paused with the reason recorded instead of retried.
        deps.db.query("UPDATE schedules SET enabled = 0, next_run_at = NULL WHERE id = ?").run(id);
        deps.events.append({
          kind: "schedule.updated",
          payload: { id, enabled: false, reason: "workflow_missing" },
          now,
        });
        return "disabled";
      }

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

      let run;
      try {
        run = enqueueWorkflowRun(deps, binding.workflowId, {
          args: binding.args,
          triggerKind: "schedule",
          scheduleId: binding.id,
          now,
        }).run;
      } catch (error) {
        if (!(error instanceof WorkflowError)) throw error;
        deps.db.query("UPDATE schedules SET enabled = 0, next_run_at = NULL WHERE id = ?").run(id);
        deps.events.append({
          kind: "schedule.updated",
          payload: { id, enabled: false, reason: error.code, detail: error.detail },
          now,
        });
        return "disabled";
      }
      insertOccurrence(
        deps.db,
        {
          scheduleId: binding.id,
          workflowTitle: workflow.title,
          scheduledFor: slot.scheduledFor,
          runId: run.id,
          manual: false,
          now,
        },
        deps.events,
      );
      advance();
      return "enqueued";
    })
    .immediate();
}

/**
 * Initializes a missing deadline and enqueues at most the latest missed slot of
 * every due binding. It never waits for a run; the worker claims it later.
 */
export function dispatchDueSchedules(
  deps: { readonly db: Database; readonly events: EventLog },
  now = Date.now(),
): DispatchStats {
  let enqueued = 0;
  let skipped = 0;
  let disabled = 0;
  const rows = deps.db
    .query<BindingRow, SQLQueryBindings[]>(
      `${BINDING_SELECT} WHERE enabled = 1 ORDER BY created_at`,
    )
    .all();
  for (const row of rows) {
    const binding = rowToBinding(row);
    const expected = row.next_run_at;
    if (expected === null) {
      const initialized = nextFor(binding.trigger, true, now);
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
    else if (outcome === "disabled") disabled += 1;
    else skipped += 1;
  }
  return { enqueued, skipped, disabled };
}
