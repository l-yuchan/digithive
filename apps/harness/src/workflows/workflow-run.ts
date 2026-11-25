import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { EventLog } from "../events/log";
import { enqueueRun, type RunRow } from "../surfaces/work/runner";
import { getWorkflow } from "./workflow-store";
import { WorkflowError } from "./workflow-store";
import { resolveWorkflowParams } from "./workflow-params";
import type { Workflow } from "./workflow-types";

/** A workflow chain may nest three deep: A calls B calls C, and C calling D stops. */
export const MAX_WORKFLOW_DEPTH = 3;

export type WorkflowTriggerKind = "schedule" | "manual" | "tool" | "script";

export type EnqueueWorkflowOptions = {
  readonly args?: Readonly<Record<string, unknown>>;
  readonly triggerKind: WorkflowTriggerKind;
  readonly parentRunId?: string | null;
  readonly sessionId?: string | null;
  readonly scheduleId?: string | null;
  /** `inline` turns a policy "ask" into a refusal: no approver is present. */
  readonly permissionProfile?: "inline";
  readonly now?: number;
  /** Overrides the definition instruction as the run goal (the app's own runs only). */
  readonly goal?: string;
};

export type PreparedRun = {
  readonly workflow: Workflow;
  readonly params: Readonly<Record<string, unknown>>;
  readonly run: RunRow;
};

export function runChainDepth(db: Database, runId: string | null | undefined): number {
  let depth = 0;
  let current = runId ?? null;
  while (current) {
    const row = db
      .query<{ parent_run_id: string | null }, SQLQueryBindings[]>(
        "SELECT parent_run_id FROM runs WHERE id = ?",
      )
      .get(current);
    if (!row) break;
    depth += 1;
    current = row.parent_run_id;
  }
  return depth;
}

function runExists(db: Database, id: string): boolean {
  return (
    db.query<{ id: string }, SQLQueryBindings[]>("SELECT id FROM runs WHERE id = ?").get(id) !==
    null
  );
}

/**
 * Creates the queued run with the values it will actually use. Validation happens
 * before a row exists, so a bad invocation cannot leave a failed run behind.
 */
export function enqueueWorkflowRun(
  deps: { readonly db: Database; readonly events: EventLog },
  workflowId: string,
  options: EnqueueWorkflowOptions,
): PreparedRun {
  const workflow = getWorkflow(deps.db, workflowId);
  if (!workflow) throw new WorkflowError("workflow_not_found", { id: workflowId });
  const resolution = resolveWorkflowParams(workflow.params, options.args ?? {});
  if (!resolution.ok) throw new WorkflowError("invalid_params", resolution.errors);
  // A conversation id is not a run row; a parent link is only recorded when it is real.
  const parentRunId =
    options.parentRunId && runExists(deps.db, options.parentRunId) ? options.parentRunId : null;
  if (parentRunId && runChainDepth(deps.db, parentRunId) >= MAX_WORKFLOW_DEPTH) {
    throw new WorkflowError("workflow_depth_exceeded", { depth: MAX_WORKFLOW_DEPTH });
  }
  const run = enqueueRun(deps.db, deps.events, {
    goal: options.goal ?? workflow.instruction,
    origin: "work",
    executor: workflow.executor,
    timeoutSeconds: workflow.timeoutSeconds,
    workflow: { id: workflow.id, title: workflow.title, params: resolution.values },
    budget: {
      params: resolution.values,
      ...(options.permissionProfile === undefined
        ? {}
        : { permissionProfile: options.permissionProfile }),
    },
    triggerKind: options.triggerKind,
    scheduleId: options.scheduleId ?? null,
    parentRunId,
    sessionId: options.sessionId ?? null,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { workflow, params: resolution.values, run };
}
