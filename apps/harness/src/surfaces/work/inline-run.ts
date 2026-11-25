import { getRun } from "./runner";
import type { WorkDeps } from "./runner";
import { executeRun } from "./execution";
import { enqueueWorkflowRun, type WorkflowTriggerKind } from "../../workflows/workflow-run";
import type { RunRow } from "./record";
import type { Workflow } from "../../workflows/workflow-types";

export type InlineRunInput = {
  readonly workflowId: string;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly triggerKind: WorkflowTriggerKind;
  readonly parentRunId?: string | null;
  readonly sessionId?: string | null;
  readonly scheduleId?: string | null;
  readonly signal?: AbortSignal;
};

export type InlineRunResult = {
  readonly runId: string;
  readonly status: string;
  readonly workflow: Workflow;
  readonly params: Readonly<Record<string, unknown>>;
  readonly durationMs: number;
  readonly result: unknown;
};

const INLINE_OWNER_PREFIX = "inline-";

/**
 * `workflow_run` executes here, inside the caller's turn or run: the child borrows
 * the caller's slot and abort signal, so waiting for it cannot deadlock the
 * two-slot queue. The row is written first so the execution is still visible in
 * history even when the caller is cancelled midway.
 */
export async function runWorkflowInline(
  deps: WorkDeps,
  input: InlineRunInput,
): Promise<InlineRunResult> {
  const now = Date.now();
  const prepared = enqueueWorkflowRun(deps, input.workflowId, {
    args: input.args ?? {},
    triggerKind: input.triggerKind,
    parentRunId: input.parentRunId ?? null,
    sessionId: input.sessionId ?? null,
    scheduleId: input.scheduleId ?? null,
    permissionProfile: "inline",
    now,
  });
  const owner = `${INLINE_OWNER_PREFIX}${crypto.randomUUID()}`;
  const budgetMs = Math.min(
    prepared.workflow.timeoutSeconds * 1_000,
    deps.limits?.totalMs ?? 30 * 60_000,
  );
  deps.db
    .query(
      "UPDATE runs SET status='running', lease_owner=?, lease_expires_at=?, attempt=attempt+1 WHERE id=? AND status='queued'",
    )
    .run(
      owner,
      new Date(now + Math.min(budgetMs, deps.leaseMs ?? 45_000)).toISOString(),
      prepared.run.id,
    );
  deps.events.append({
    kind: "run.started",
    runId: prepared.run.id,
    sessionId: input.sessionId ?? null,
    payload: { owner, inline: true, parentRunId: input.parentRunId ?? null },
    now,
  });
  const claimed = getRun(deps.db, prepared.run.id);
  if (!claimed) throw new Error("run_not_found");
  const started = Date.now();
  const outcome = await executeRun(deps, claimed, {
    totalMs: budgetMs,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const settled: RunRow = getRun(deps.db, prepared.run.id) ?? claimed;
  const result = parseResult(settled.resultJson);
  if (settled.status === "interrupted" && input.signal?.aborted) {
    throw input.signal.reason ?? new Error("run_cancelled");
  }
  return {
    runId: settled.id,
    status: settled.status,
    workflow: prepared.workflow,
    params: prepared.params,
    durationMs: Date.now() - started,
    result: outcome === "succeeded" ? result : (result ?? { error: settled.status }),
  };
}

function parseResult(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { text: raw };
  }
}
