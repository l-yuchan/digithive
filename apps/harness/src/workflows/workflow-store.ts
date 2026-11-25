import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { EventLog } from "../events/log";
import {
  CreateWorkflowSchema,
  UpdateWorkflowSchema,
  WORKFLOW_SELECT,
  rowToWorkflow,
  type CreateWorkflowInput,
  type RunSummary,
  type ScheduleBinding,
  type UpdateWorkflowInput,
  type Workflow,
  type WorkflowRow,
  type WorkflowView,
} from "./workflow-types";
import { resolveWorkflowParams } from "./workflow-params";
import { valueMatchesParamType } from "./workflow-types";
import { listBindings, parseArgs } from "../scheduler/schedule-types";

/**
 * The app's own jobs, installed under `<scriptsRoot>/jobs` at every start. A job is
 * not a kind of workflow: it is a script whose path happens to belong to the app.
 */
export const COLLECTION_SCRIPT = "jobs/collection.ts";
export const BRIEFING_SCRIPT = "jobs/briefing.ts";

/** A refusal a tool or route can turn into an answer, with the facts attached. */
export class WorkflowError extends Error {
  readonly code: string;
  readonly detail: unknown;

  constructor(code: string, detail: unknown = null) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

export function bindingRowsFor(db: Database, workflowId: string): ScheduleBinding[] {
  return listBindings(db, workflowId);
}

function lastRunFor(db: Database, workflowId: string): RunSummary | null {
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
      `SELECT id,status,trigger_kind,params_json,result_json,created_at,settled_at
         FROM runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(workflowId);
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

export function getWorkflow(db: Database, id: string): Workflow | null {
  const row = db.query<WorkflowRow, SQLQueryBindings[]>(`${WORKFLOW_SELECT} WHERE id = ?`).get(id);
  return row ? rowToWorkflow(row) : null;
}

export function listWorkflows(db: Database): WorkflowView[] {
  return db
    .query<WorkflowRow, SQLQueryBindings[]>(`${WORKFLOW_SELECT} ORDER BY updated_at DESC`)
    .all()
    .map((row) => {
      const workflow = rowToWorkflow(row);
      return {
        ...workflow,
        schedules: bindingRowsFor(db, workflow.id),
        lastRun: lastRunFor(db, workflow.id),
      };
    });
}

function syncFts(db: Database, workflow: Workflow): void {
  db.query("DELETE FROM workflows_fts WHERE workflow_id = ?").run(workflow.id);
  db.query("INSERT INTO workflows_fts (workflow_id, text) VALUES (?, ?)").run(
    workflow.id,
    `${workflow.title} ${workflow.instruction}`,
  );
}

export function createWorkflow(
  db: Database,
  input: CreateWorkflowInput,
  now = Date.now(),
  events?: EventLog,
): Workflow {
  const parsed = CreateWorkflowSchema.parse(input);
  const id = crypto.randomUUID();
  const iso = new Date(now).toISOString();
  const created = db.transaction((): Workflow => {
    db.query(
      `INSERT INTO workflows (id,title,instruction,executor_json,params_json,timeout_seconds,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      parsed.title,
      parsed.instruction,
      JSON.stringify(parsed.executor),
      JSON.stringify(parsed.params),
      parsed.timeoutSeconds,
      iso,
      iso,
    );
    const workflow = getWorkflow(db, id);
    if (!workflow) throw new WorkflowError("workflow_not_created");
    syncFts(db, workflow);
    return workflow;
  })();
  events?.append({ kind: "workflow.created", payload: { id, title: created.title }, now });
  return created;
}

export type UpdateResult = { readonly workflow: Workflow; readonly rebound: readonly string[] };

/**
 * A definition edit that would leave a binding unable to run is refused, and the
 * refusal names the bindings. `force` keeps the passing values and drops the
 * rest, so the owner can still fix the definition first and the schedule after.
 */
export function updateWorkflow(
  db: Database,
  id: string,
  patch: UpdateWorkflowInput,
  options: { readonly now?: number; readonly events?: EventLog; readonly force?: boolean } = {},
): UpdateResult {
  const now = options.now ?? Date.now();
  const existing = getWorkflow(db, id);
  if (!existing) throw new WorkflowError("workflow_not_found");
  const parsed = UpdateWorkflowSchema.parse(patch);
  const params = parsed.params ?? existing.params;
  const merged = {
    title: parsed.title ?? existing.title,
    instruction: parsed.instruction ?? existing.instruction,
    executor: parsed.executor ?? existing.executor,
    params,
    timeoutSeconds: parsed.timeoutSeconds ?? existing.timeoutSeconds,
  };
  const paramsChanged = parsed.params !== undefined;
  const bindings = paramsChanged ? bindingRowsFor(db, id) : [];
  const broken: { id: string; errors: readonly string[] }[] = [];
  const rebind = new Map<string, Readonly<Record<string, unknown>>>();
  for (const binding of bindings) {
    const resolution = resolveWorkflowParams(params, binding.args);
    if (resolution.ok) continue;
    if (options.force) {
      const keep: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(binding.args)) {
        const declared = params.find((param) => param.name === key);
        if (declared && valueMatchesParamType(declared.type, value)) keep[key] = value;
      }
      rebind.set(binding.id, keep);
    } else broken.push({ id: binding.id, errors: resolution.errors });
  }
  if (broken.length > 0) throw new WorkflowError("schedule_args_invalid", broken);

  const iso = new Date(now).toISOString();
  const updated = db.transaction((): Workflow => {
    db.query(
      `UPDATE workflows SET title=?,instruction=?,executor_json=?,params_json=?,timeout_seconds=?,updated_at=? WHERE id=?`,
    ).run(
      merged.title,
      merged.instruction,
      JSON.stringify(merged.executor),
      JSON.stringify(merged.params),
      merged.timeoutSeconds,
      iso,
      id,
    );
    for (const [bindingId, args] of rebind) {
      db.query("UPDATE schedules SET args_json=?, updated_at=? WHERE id=?").run(
        JSON.stringify(args),
        iso,
        bindingId,
      );
    }
    const workflow = getWorkflow(db, id);
    if (!workflow) throw new WorkflowError("workflow_not_found");
    syncFts(db, workflow);
    return workflow;
  })();
  options.events?.append({
    kind: "workflow.updated",
    payload: { id, title: updated.title, rebound: [...rebind.keys()] },
    now,
  });
  return { workflow: updated, rebound: [...rebind.keys()] };
}

/** Deleting the definition never deletes history; bindings must be removed first. */
export function deleteWorkflow(
  db: Database,
  id: string,
  options: { readonly cascade?: boolean; readonly now?: number; readonly events?: EventLog } = {},
): { removedSchedules: readonly string[] } {
  const now = options.now ?? Date.now();
  const workflow = getWorkflow(db, id);
  if (!workflow) throw new WorkflowError("workflow_not_found");
  const bindings = bindingRowsFor(db, id);
  if (bindings.length > 0 && !options.cascade) {
    throw new WorkflowError(
      "schedules_present",
      bindings.map((binding) => ({ id: binding.id, nextRunAt: binding.nextRunAt })),
    );
  }
  db.transaction((): void => {
    for (const binding of bindings) {
      db.query("UPDATE schedule_occurrences SET schedule_id = NULL WHERE schedule_id = ?").run(
        binding.id,
      );
      db.query("DELETE FROM schedules WHERE id = ?").run(binding.id);
    }
    db.query("DELETE FROM workflows_fts WHERE workflow_id = ?").run(id);
    db.query("DELETE FROM workflows WHERE id = ?").run(id);
  }).immediate();
  options.events?.append({
    kind: "workflow.deleted",
    payload: { id, title: workflow.title, removedSchedules: bindings.map((row) => row.id) },
    now,
  });
  return { removedSchedules: bindings.map((row) => row.id) };
}

export function runsForWorkflow(db: Database, workflowId: string, limit = 10): RunSummary[] {
  return db
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
      `SELECT id,status,trigger_kind,params_json,result_json,created_at,settled_at
         FROM runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(workflowId, limit)
    .map((row) => ({
      id: row.id,
      status: row.status,
      triggerKind: row.trigger_kind,
      params: parseArgs(row.params_json),
      resultJson: row.result_json,
      createdAt: row.created_at,
      settledAt: row.settled_at,
    }));
}

export function workflowView(db: Database, id: string): WorkflowView | null {
  const workflow = getWorkflow(db, id);
  if (!workflow) return null;
  return {
    ...workflow,
    schedules: bindingRowsFor(db, id),
    lastRun: lastRunFor(db, id),
  };
}
