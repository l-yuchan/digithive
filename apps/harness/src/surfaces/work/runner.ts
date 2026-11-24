import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { EventLog } from "../../events/log";
import type { PolicyRule } from "../../core/policy";
import { isLeaseExpired, leaseExpiry } from "../../core/run-state";
import type { ToolRegistry } from "../../tools/registry";
import type { StreamFn } from "../../providers/openai";
import { ok } from "node:assert/strict";
export { executeRun } from "./execution";

export type WorkDeps = {
  readonly db: Database;
  readonly events: EventLog;
  readonly stream: StreamFn;
  readonly tools: ToolRegistry;
  readonly policy: readonly PolicyRule[];
  readonly now?: () => number;
  readonly limits?: { readonly firstTokenMs: number; readonly idleMs: number; readonly toolMs: number; readonly maxOutputTokens: number; readonly maxToolRounds: number; readonly totalMs: number };
  readonly maxConcurrent?: number;
  readonly leaseMs?: number;
};

export const WORK_LIMITS = {
  firstTokenMs: 60_000,
  idleMs: 120_000,
  toolMs: 30_000,
  maxOutputTokens: 2_048,
  maxToolRounds: 6,
  totalMs: 30 * 60_000,
};

export type RunRow = {
  id: string;
  sessionId: string | null;
  parentRunId: string | null;
  origin: string;
  goal: string;
  status: string;
  cancelIntent: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  attempt: number;
  budgetJson: string;
  resultJson: string | null;
  stateJson: string | null;
  createdAt: string;
  settledAt: string | null;
};


type StoredRun = {
  id: string; session_id: string | null; parent_run_id: string | null; origin: string; goal: string; status: string;
  cancel_intent: string | null; lease_owner: string | null; lease_expires_at: string | null; attempt: number;
  budget_json: string; result_json: string | null; state_json: string | null; created_at: string; settled_at: string | null;
};
const RunShape = (row: StoredRun): RunRow => ({
  id: (row["id"]),
  sessionId: row["session_id"] === null ? null : (row["session_id"]),
  parentRunId: row["parent_run_id"] === null ? null : (row["parent_run_id"]),
  origin: (row["origin"]),
  goal: (row["goal"]),
  status: (row["status"]),
  cancelIntent: row["cancel_intent"] === null ? null : (row["cancel_intent"]),
  leaseOwner: row["lease_owner"] === null ? null : (row["lease_owner"]),
  leaseExpiresAt: row["lease_expires_at"] === null ? null : (row["lease_expires_at"]),
  attempt: (row["attempt"]),
  budgetJson: (row["budget_json"]),
  resultJson: row["result_json"] === null ? null : (row["result_json"]),
  stateJson: row["state_json"] === null ? null : (row["state_json"]),
  createdAt: (row["created_at"]),
  settledAt: row["settled_at"] === null ? null : (row["settled_at"]),
});

const SELECT = "SELECT id, session_id, parent_run_id, origin, goal, status, cancel_intent, lease_owner, lease_expires_at, attempt, budget_json, result_json, state_json, created_at, settled_at FROM runs";

export function getRun(db: Database, id: string): RunRow | null {
  const row = db.query<StoredRun, SQLQueryBindings[]>(`${SELECT} WHERE id = ?`).get(id);
  return row ? RunShape(row) : null;
}

export function listRuns(db: Database, limit = 30): RunRow[] {
  return db.query<StoredRun, SQLQueryBindings[]>(`${SELECT} ORDER BY created_at DESC LIMIT ?`).all(limit).map(RunShape);
}

export type RunView = RunRow & {
  readonly pendingApprovalId: string | null;
  readonly pendingTool: string | null;
};

/** Run rows plus the pending approval the UI must render, if any. */
export function withApprovals(db: Database, runs: readonly RunRow[]): RunView[] {
  return runs.map((run) => {
    const row = db
      .query<{ id: string; name: string | null }, SQLQueryBindings[]>("SELECT a.id AS id, t.name AS name FROM approvals a LEFT JOIN tool_calls t ON t.id = a.tool_call_id WHERE a.run_id = ? AND a.status = 'pending' ORDER BY a.requested_at DESC LIMIT 1")
      .get(run.id);
    return { ...run, pendingApprovalId: row?.id ?? null, pendingTool: row?.name ?? null };
  });
}

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
  if (!Array.isArray(fields.inputRefs) || fields.inputRefs.length === 0 || fields.inputRefs.some((ref) => typeof ref !== "string" || ref.trim().length === 0)) missing.push("inputRefs");
  if (fields.permissionProfile !== "read-only" && fields.permissionProfile !== "workspace-write") missing.push("permissionProfile");
  if (!fields.budget || !Number.isSafeInteger(fields.budget.maxMicroUsd) || fields.budget.maxMicroUsd < 0 || !Number.isSafeInteger(fields.budget.maxToolCalls) || fields.budget.maxToolCalls < 0) missing.push("budget");
  if (!fields.completionCondition || fields.completionCondition.trim().length === 0) missing.push("completionCondition");
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
    readonly now?: number;
  },
): RunRow {
  const now = input.now ?? Date.now();
  const id = crypto.randomUUID();
  const iso = new Date(now).toISOString();
  db.query(
    `INSERT INTO runs (id, session_id, parent_run_id, origin, goal, status, budget_json, created_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
  ).run(
    id,
    input.sessionId ?? null,
    input.parentRunId ?? null,
    input.origin ?? "work",
    input.goal.slice(0, 4_096),
    JSON.stringify(input.delegation ?? input.budget ?? {}),
    iso,
  );
  events.append({
    kind: "run.queued",
    runId: id,
    sessionId: input.sessionId ?? null,
    payload: { goal: input.goal, origin: input.origin ?? "work", parentRunId: input.parentRunId ?? null },
    now,
  });
  const run = getRun(db, id);
  if (!run) throw new Error("run_not_created");
  return run;
}

/** Claims the oldest queued run under the concurrency cap, with a lease. */
export function claimNext(db: Database, events: EventLog, owner: string, maxConcurrent = 2, now = Date.now(), leaseMs = 45_000): RunRow | null {
  return db.transaction(() => {
  const running = db.query<{ n: number }, SQLQueryBindings[]>("SELECT count(*) AS n FROM runs WHERE origin IN ('work','delegation') AND status = 'running'").get();
  ok(running, "count query returns one aggregate row");
  if (running.n >= maxConcurrent) return null;
  const candidate = db
    .query<{ id: string }, SQLQueryBindings[]>("SELECT id FROM runs WHERE status = 'queued' AND origin IN ('work','delegation') ORDER BY created_at LIMIT 1")
    .get();
  if (!candidate) return null;
  const changed = db
    .query("UPDATE runs SET status = 'running', lease_owner = ?, lease_expires_at = ?, attempt = attempt + 1 WHERE id = ? AND status = 'queued'")
    .run(owner, leaseExpiry(now, leaseMs), candidate.id);
  if (changed.changes === 0) return null;
  events.append({ kind: "run.started", runId: candidate.id, payload: { owner }, now });
  return getRun(db, candidate.id);
  }).immediate();
}


export type Decision = "approve" | "reject";

/** Records a decision and re-queues the run so a worker resumes it. */
export function decideApproval(
  deps: Pick<WorkDeps, "db" | "events">,
  input: { readonly runId: string; readonly approvalId: string; readonly decision: Decision; readonly now?: number },
): { status: string } {
  const now = input.now ?? Date.now();
  return deps.db.transaction(() => {
  const approval = deps.db.query<{ id: string; run_id: string; status: string; requested_at: string }, SQLQueryBindings[]>("SELECT id, run_id, status, requested_at FROM approvals WHERE id = ?").get(input.approvalId);
  if (!approval || approval.run_id !== input.runId) throw new Error("approval_not_found");
  if (approval.status !== "pending") throw new Error("approval_already_decided");
  if (getRun(deps.db, input.runId)?.status !== "awaiting_approval") throw new Error("run_not_awaiting_approval");
  if (Date.parse(approval.requested_at) + 30 * 60_000 <= now) throw new Error("approval_expired");
  const status = input.decision === "approve" ? "approved" : "rejected";
  deps.db.query("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?").run(status, new Date(now).toISOString(), approval.id);
  deps.db.query("UPDATE tool_calls SET decision_by = 'user', decision = ? WHERE run_id = ? AND status = 'pending'").run(status, input.runId);
  deps.db.query("UPDATE runs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL WHERE id = ?").run(input.runId);
  deps.events.append({ kind: "approval.decided", runId: input.runId, payload: { approvalId: approval.id, status }, now });
  return { status };
  }).immediate();
}

/** Expires approvals nobody answered, and settles runs whose lease died. */
export function reconcileWork(db: Database, events: EventLog, now = Date.now(), ttlMs = 30 * 60_000): { expiredApprovals: number; interrupted: number } {
  return db.transaction(() => {
  const stale = db
    .query<{ id: string; run_id: string }, SQLQueryBindings[]>("SELECT id, run_id FROM approvals WHERE status = 'pending' AND requested_at <= ?")
    .all(new Date(now - ttlMs).toISOString());
  for (const approval of stale) {
    db.query("UPDATE approvals SET status = 'expired', decided_at = ? WHERE id = ?").run(new Date(now).toISOString(), approval.id);
    db.query("UPDATE runs SET status = 'queued' WHERE id = ? AND status = 'awaiting_approval'").run(approval.run_id);
    events.append({ kind: "approval.expired", runId: approval.run_id, payload: { approvalId: approval.id }, now });
  }
  const live = db.query<{ id: string; lease_expires_at: string | null }, SQLQueryBindings[]>("SELECT id, lease_expires_at FROM runs WHERE status = 'running'").all();
  let interrupted = 0;
  for (const run of live) {
    if (!isLeaseExpired(run.lease_expires_at, now)) continue;
    db.query("UPDATE runs SET status = 'interrupted', cancel_intent = 'host_restart', settled_at = ? WHERE id = ?").run(new Date(now).toISOString(), run.id);
    events.append({ kind: "run.interrupted", runId: run.id, payload: { reason: "lease_expired" }, now });
    interrupted += 1;
  }
  return { expiredApprovals: stale.length, interrupted };
  }).immediate();
}
