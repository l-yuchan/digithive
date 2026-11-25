import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { EventLog } from "../../events/log";
import type { PolicyRule } from "../../core/policy";
import { RunExecutorSchema, type RunExecutor } from "../../core/executor";
import { leaseExpiry } from "../../core/run-state";
import type { ToolRegistry } from "../../tools/registry";
import type { ScriptTicketIssuer } from "../../sdk/ticket";
import type { StreamFn } from "../../providers/openai";
import type { ProviderDiagnostic } from "../../providers/router";
import { ok } from "node:assert/strict";
import { getRun, type RunRow } from "./record";
import type { SettleHooks } from "./settle";
export { executeRun } from "./execution";
export { getRun, listRuns, withApprovals, type RunRow, type RunView } from "./record";
export { reconcileWork } from "./reconcile";

export type WorkDeps = {
  readonly db: Database;
  readonly events: EventLog;
  readonly stream: StreamFn;
  readonly tools: ToolRegistry;
  readonly policy: readonly PolicyRule[];
  readonly now?: () => number;
  readonly limits?: {
    readonly firstTokenMs: number;
    readonly idleMs: number;
    readonly toolMs: number;
    readonly maxOutputTokens: number;
    readonly maxToolRounds: number;
    readonly totalMs: number;
  };
  readonly maxConcurrent?: number;
  readonly leaseMs?: number;
  /** Issues the run-scoped SDK bridge ticket a script needs; absent means no SDK. */
  readonly sdk?: ScriptTicketIssuer;
  readonly scriptsRoot?: string;
  /** Provider routing decisions (retry, fallback, exhausted) for the execution log. */
  readonly streamDiagnostics?: (diagnostics: readonly ProviderDiagnostic[]) => void;
  /** Told when any run settles; the app attaches its queue drain and title run. */
  readonly hooks?: SettleHooks;
  /** Worker SIGTERM/SIGINT: aborts in-flight executors as host_restart. */
  readonly shutdownSignal?: AbortSignal;
};

export const WORK_LIMITS = {
  firstTokenMs: 60_000,
  idleMs: 120_000,
  toolMs: 30_000,
  maxOutputTokens: 2_048,
  maxToolRounds: 6,
  totalMs: 30 * 60_000,
};

export type DelegateFields = {
  readonly goal: string;
  readonly inputRefs: readonly string[];
  readonly permissionProfile: string;
  readonly budget: { readonly maxMicroUsd: number; readonly maxToolCalls: number };
  readonly completionCondition: string;
};

/**
 * The five-field contract from the plan: a delegated run without a completion
 * condition, permission profile, input refs, or budget is rejected outright.
 */
export function validateDelegation(fields: Partial<DelegateFields>): string[] {
  const missing: string[] = [];
  if (!fields.goal || fields.goal.trim().length === 0) missing.push("goal");
  if (
    !Array.isArray(fields.inputRefs) ||
    fields.inputRefs.length === 0 ||
    fields.inputRefs.some((ref) => typeof ref !== "string" || ref.trim().length === 0)
  )
    missing.push("inputRefs");
  if (fields.permissionProfile !== "read-only" && fields.permissionProfile !== "workspace-write")
    missing.push("permissionProfile");
  if (
    !fields.budget ||
    !Number.isSafeInteger(fields.budget.maxMicroUsd) ||
    fields.budget.maxMicroUsd < 0 ||
    !Number.isSafeInteger(fields.budget.maxToolCalls) ||
    fields.budget.maxToolCalls < 0
  )
    missing.push("budget");
  if (!fields.completionCondition || fields.completionCondition.trim().length === 0)
    missing.push("completionCondition");
  return missing;
}

export function enqueueRun(
  db: Database,
  events: EventLog,
  input: {
    readonly goal: string;
    readonly origin?: "work" | "delegation";
    readonly sessionId?: string | null;
    readonly parentRunId?: string | null;
    readonly budget?: unknown;
    readonly delegation?: DelegateFields;
    readonly executor?: RunExecutor;
    readonly timeoutSeconds?: number;
    /** The definition this run executes, captured so history survives deletion. */
    readonly workflow?: { readonly id: string; readonly title: string; readonly params: unknown };
    readonly triggerKind?: "schedule" | "manual" | "tool" | "script" | "delegation";
    readonly scheduleId?: string | null;
    readonly now?: number;
  },
): RunRow {
  const now = input.now ?? Date.now();
  const id = crypto.randomUUID();
  const iso = new Date(now).toISOString();
  const executor = RunExecutorSchema.parse(input.executor ?? { kind: "agent" });
  const timeoutSeconds = input.timeoutSeconds ?? 1_800;
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86_400)
    throw new Error("invalid_timeout");
  db.query(
    `INSERT INTO runs (id, session_id, parent_run_id, origin, goal, status, budget_json, executor_json, timeout_seconds, workflow_id, workflow_title, schedule_id, trigger_kind, params_json, created_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.sessionId ?? null,
    input.parentRunId ?? null,
    input.origin ?? "work",
    input.goal.slice(0, 4_096),
    JSON.stringify(input.delegation ?? input.budget ?? {}),
    JSON.stringify(executor),
    timeoutSeconds,
    input.workflow?.id ?? null,
    input.workflow?.title ?? null,
    input.scheduleId ?? null,
    input.triggerKind ?? null,
    JSON.stringify(input.workflow?.params ?? {}),
    iso,
  );
  events.append({
    kind: "run.queued",
    runId: id,
    sessionId: input.sessionId ?? null,
    payload: {
      goal: input.goal,
      origin: input.origin ?? "work",
      parentRunId: input.parentRunId ?? null,
    },
    now,
  });
  const run = getRun(db, id);
  if (!run) throw new Error("run_not_created");
  return run;
}

/** Claims the oldest queued run under the concurrency cap, with a lease. */
export function claimNext(
  db: Database,
  events: EventLog,
  owner: string,
  maxConcurrent = 2,
  now = Date.now(),
  leaseMs = 45_000,
): RunRow | null {
  return db
    .transaction(() => {
      const running = db
        .query<{ n: number }, SQLQueryBindings[]>(
          "SELECT count(*) AS n FROM runs WHERE origin IN ('work','delegation') AND status = 'running'",
        )
        .get();
      ok(running, "count query returns one aggregate row");
      if (running.n >= maxConcurrent) return null;
      const candidate = db
        .query<{ id: string }, SQLQueryBindings[]>(
          "SELECT id FROM runs WHERE status = 'queued' AND origin IN ('work','delegation') ORDER BY created_at LIMIT 1",
        )
        .get();
      if (!candidate) return null;
      const changed = db
        .query(
          "UPDATE runs SET status = 'running', lease_owner = ?, lease_expires_at = ?, attempt = attempt + 1 WHERE id = ? AND status = 'queued'",
        )
        .run(owner, leaseExpiry(now, leaseMs), candidate.id);
      if (changed.changes === 0) return null;
      events.append({ kind: "run.started", runId: candidate.id, payload: { owner }, now });
      return getRun(db, candidate.id);
    })
    .immediate();
}

export type Decision = "approve" | "reject";

/** Records a decision and re-queues the run so a worker resumes it. */
export function decideApproval(
  deps: Pick<WorkDeps, "db" | "events">,
  input: {
    readonly runId: string;
    readonly approvalId: string;
    readonly decision: Decision;
    readonly now?: number;
  },
): { status: string } {
  const now = input.now ?? Date.now();
  return deps.db
    .transaction(() => {
      const approval = deps.db
        .query<
          { id: string; run_id: string; status: string; requested_at: string },
          SQLQueryBindings[]
        >("SELECT id, run_id, status, requested_at FROM approvals WHERE id = ?")
        .get(input.approvalId);
      if (!approval || approval.run_id !== input.runId) throw new Error("approval_not_found");
      if (approval.status !== "pending") throw new Error("approval_already_decided");
      if (getRun(deps.db, input.runId)?.status !== "awaiting_approval")
        throw new Error("run_not_awaiting_approval");
      if (Date.parse(approval.requested_at) + 30 * 60_000 <= now)
        throw new Error("approval_expired");
      const status = input.decision === "approve" ? "approved" : "rejected";
      deps.db
        .query("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?")
        .run(status, new Date(now).toISOString(), approval.id);
      deps.db
        .query(
          "UPDATE tool_calls SET decision_by = 'user', decision = ? WHERE run_id = ? AND status = 'pending'",
        )
        .run(status, input.runId);
      deps.db
        .query(
          "UPDATE runs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL WHERE id = ?",
        )
        .run(input.runId);
      deps.events.append({
        kind: "approval.decided",
        runId: input.runId,
        payload: { approvalId: approval.id, status },
        now,
      });
      return { status };
    })
    .immediate();
}
