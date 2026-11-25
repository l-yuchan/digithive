import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { EventLog } from "../events/log";
import { getRun, type RunRow } from "../surfaces/work/runner";
import { WorkflowError, getWorkflow } from "../workflows/workflow-store";
import { resolveWorkflowParams } from "../workflows/workflow-params";
import { enqueueWorkflowRun } from "../workflows/workflow-run";
import {
  CreateScheduleBindingSchema,
  UpdateScheduleBindingSchema,
  type CreateScheduleBindingInput,
  type ScheduleBinding,
  type ScheduleBindingView,
  type RunSummary,
  type UpdateScheduleBindingInput,
} from "../workflows/workflow-types";
import { nextDueAfter } from "./triggers";
import { getBindingRow, parseArgs, rowToBinding } from "./schedule-types";

function nextFor(
  trigger: ScheduleBinding["trigger"],
  enabled: boolean,
  now: number,
): string | null {
  if (!enabled) return null;
  const at = nextDueAfter(trigger, now);
  return at === null ? null : new Date(at).toISOString();
}

/** A binding must be runnable the moment it is saved, so its args are checked here. */
function requireValidArgs(
  workflowId: string,
  args: Readonly<Record<string, unknown>>,
  db: Database,
): void {
  const workflow = getWorkflow(db, workflowId);
  if (!workflow) throw new WorkflowError("workflow_not_found", { id: workflowId });
  const resolution = resolveWorkflowParams(workflow.params, args);
  if (!resolution.ok) throw new WorkflowError("invalid_params", resolution.errors);
}

export function getBinding(db: Database, id: string): ScheduleBinding | null {
  const row = getBindingRow(db, id);
  return row ? rowToBinding(row) : null;
}

export function listBindingViews(db: Database, workflowId?: string): ScheduleBindingView[] {
  const rows = db
    .query<
      {
        id: string;
        workflow_id: string | null;
        trigger_json: string;
        enabled: number;
        args_json: string;
        next_run_at: string | null;
        created_at: string;
        updated_at: string;
        workflow_title: string | null;
      },
      SQLQueryBindings[]
    >(
      `SELECT s.id,s.workflow_id,s.trigger_json,s.enabled,s.args_json,s.next_run_at,s.created_at,
              s.updated_at,w.title AS workflow_title
         FROM schedules s LEFT JOIN workflows w ON w.id = s.workflow_id
        ${workflowId ? "WHERE s.workflow_id = ?" : ""}
        ORDER BY s.created_at`,
    )
    .all(...(workflowId ? [workflowId] : []));
  return rows.map((row) => ({
    ...rowToBinding(row),
    workflowTitle: row.workflow_title ?? "",
    lastRun: lastRunOfBinding(db, row.id),
  }));
}

function lastRunOfBinding(db: Database, bindingId: string): RunSummary | null {
  const row = db
    .query<
      {
        id: string;
        status: string;
        trigger_kind: string | null;
        params_json: string;
        result_json: string | null;
        created_at: string;
        settled_at: string | null;
      },
      SQLQueryBindings[]
    >(
      `SELECT r.id,r.status,r.trigger_kind,r.params_json,r.result_json,r.created_at,r.settled_at
         FROM schedule_occurrences o JOIN runs r ON r.id = o.run_id
        WHERE o.schedule_id = ? ORDER BY o.created_at DESC LIMIT 1`,
    )
    .get(bindingId);
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    triggerKind: row.trigger_kind,
    params: parseArgs(row.params_json),
    resultJson: row.result_json,
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}

export function createBinding(
  db: Database,
  input: CreateScheduleBindingInput,
  now = Date.now(),
  events?: EventLog,
): ScheduleBinding {
  const parsed = CreateScheduleBindingSchema.parse(input);
  requireValidArgs(parsed.workflowId, parsed.args, db);
  const id = crypto.randomUUID();
  const iso = new Date(now).toISOString();
  db.query(
    `INSERT INTO schedules (id,workflow_id,trigger_json,enabled,args_json,next_run_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    parsed.workflowId,
    JSON.stringify(parsed.trigger),
    parsed.enabled ? 1 : 0,
    JSON.stringify(parsed.args),
    nextFor(parsed.trigger, parsed.enabled, now),
    iso,
    iso,
  );
  events?.append({ kind: "schedule.created", payload: { id, workflowId: parsed.workflowId }, now });
  const created = getBinding(db, id);
  if (!created) throw new WorkflowError("schedule_not_created");
  return created;
}

export function updateBinding(
  db: Database,
  id: string,
  patch: UpdateScheduleBindingInput,
  now = Date.now(),
  events?: EventLog,
): ScheduleBinding | null {
  const existing = getBinding(db, id);
  if (!existing) return null;
  const parsed = UpdateScheduleBindingSchema.parse(patch);
  const trigger = parsed.trigger ?? existing.trigger;
  const enabled = parsed.enabled ?? existing.enabled;
  const args = parsed.args ?? existing.args;
  if (parsed.args !== undefined) requireValidArgs(existing.workflowId, args, db);
  const triggerChanged =
    parsed.trigger !== undefined &&
    JSON.stringify(parsed.trigger) !== JSON.stringify(existing.trigger);
  const shouldRecompute = triggerChanged || enabled !== existing.enabled;
  const nextRunAt = shouldRecompute
    ? nextFor(trigger, enabled, now)
    : enabled
      ? existing.nextRunAt
      : null;
  db.query(
    `UPDATE schedules SET trigger_json=?,enabled=?,args_json=?,next_run_at=?,updated_at=? WHERE id=?`,
  ).run(
    JSON.stringify(trigger),
    enabled ? 1 : 0,
    JSON.stringify(args),
    nextRunAt,
    new Date(now).toISOString(),
    id,
  );
  events?.append({ kind: "schedule.updated", payload: { id, enabled }, now });
  return getBinding(db, id);
}

/** Occurrences keep their run; only the binding link is cleared. */
export function deleteBinding(
  db: Database,
  id: string,
  events?: EventLog,
  now = Date.now(),
): boolean {
  return db
    .transaction(() => {
      const existing = getBinding(db, id);
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
    readonly scheduleId: string;
    readonly workflowTitle: string;
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
    input.scheduleId,
    input.workflowTitle,
    input.scheduledFor,
    input.runId,
    input.manual ? 1 : 0,
    new Date(input.now).toISOString(),
  );
  events?.append({
    kind: "workflow.run",
    runId: input.runId,
    payload: {
      scheduleId: input.scheduleId,
      scheduledFor: input.scheduledFor,
      manual: input.manual,
    },
    now: input.now,
  });
}

export type ScheduleRun = RunRow & {
  readonly scheduledFor: string;
  readonly manual: boolean;
};

export function bindingRuns(db: Database, bindingId: string): ScheduleRun[] | null {
  if (!getBinding(db, bindingId)) return null;
  const rows = db
    .query<{ run_id: string; scheduled_for: string; manual: number }, SQLQueryBindings[]>(
      "SELECT run_id, scheduled_for, manual FROM schedule_occurrences WHERE schedule_id = ? ORDER BY created_at DESC",
    )
    .all(bindingId);
  const runs: ScheduleRun[] = [];
  for (const row of rows) {
    const run = getRun(db, row.run_id);
    if (run) runs.push({ ...run, scheduledFor: row.scheduled_for, manual: row.manual === 1 });
  }
  return runs;
}

export function countBindings(db: Database, workflowId: string): number {
  const row = db
    .query<{ n: number }, SQLQueryBindings[]>(
      "SELECT count(*) AS n FROM schedules WHERE workflow_id = ?",
    )
    .get(workflowId);
  return row?.n ?? 0;
}

function bumpOccurrenceTime(db: Database, bindingId: string, start: number): string {
  let now = start;
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const iso = new Date(now).toISOString();
    const row = db
      .query<{ id: string }, SQLQueryBindings[]>(
        "SELECT id FROM schedule_occurrences WHERE schedule_id = ? AND scheduled_for = ?",
      )
      .get(bindingId, iso);
    if (!row) return iso;
    now += 1;
  }
  throw new Error("occurrence_time_conflict");
}

/**
 * Manual run of a binding: it starts immediately on the worker and records a
 * manual occurrence. `next_run_at` is untouched, so pressing run never shifts
 * the automation.
 */
export function runBindingNow(
  deps: { readonly db: Database; readonly events: EventLog },
  bindingId: string,
  options: { readonly args?: Readonly<Record<string, unknown>>; readonly now?: number } = {},
): { run: RunRow; scheduledFor: string; binding: ScheduleBinding } | null {
  const now = options.now ?? Date.now();
  const binding = getBinding(deps.db, bindingId);
  if (!binding) return null;
  return deps.db
    .transaction(() => {
      const prepared = enqueueWorkflowRun(deps, binding.workflowId, {
        args: options.args ?? binding.args,
        triggerKind: "manual",
        scheduleId: binding.id,
        now,
      });
      const scheduledFor = bumpOccurrenceTime(deps.db, binding.id, now);
      insertOccurrence(
        deps.db,
        {
          scheduleId: binding.id,
          workflowTitle: prepared.workflow.title,
          scheduledFor,
          runId: prepared.run.id,
          manual: true,
          now,
        },
        deps.events,
      );
      return { run: prepared.run, scheduledFor, binding };
    })
    .immediate();
}
