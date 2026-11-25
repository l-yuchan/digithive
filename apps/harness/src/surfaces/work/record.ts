import type { Database, SQLQueryBindings } from "bun:sqlite";

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
  executorJson: string;
  timeoutSeconds: number;
  createdAt: string;
  settledAt: string | null;
};

type StoredRun = {
  id: string;
  session_id: string | null;
  parent_run_id: string | null;
  origin: string;
  goal: string;
  status: string;
  cancel_intent: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  attempt: number;
  budget_json: string;
  result_json: string | null;
  state_json: string | null;
  executor_json: string;
  timeout_seconds: number;
  created_at: string;
  settled_at: string | null;
};

const RunShape = (row: StoredRun): RunRow => ({
  id: row["id"],
  sessionId: row["session_id"] === null ? null : row["session_id"],
  parentRunId: row["parent_run_id"] === null ? null : row["parent_run_id"],
  origin: row["origin"],
  goal: row["goal"],
  status: row["status"],
  cancelIntent: row["cancel_intent"] === null ? null : row["cancel_intent"],
  leaseOwner: row["lease_owner"] === null ? null : row["lease_owner"],
  leaseExpiresAt: row["lease_expires_at"] === null ? null : row["lease_expires_at"],
  attempt: row["attempt"],
  budgetJson: row["budget_json"],
  resultJson: row["result_json"] === null ? null : row["result_json"],
  stateJson: row["state_json"] === null ? null : row["state_json"],
  executorJson: row["executor_json"],
  timeoutSeconds: row["timeout_seconds"],
  createdAt: row["created_at"],
  settledAt: row["settled_at"] === null ? null : row["settled_at"],
});

const SELECT =
  "SELECT id, session_id, parent_run_id, origin, goal, status, cancel_intent, lease_owner, lease_expires_at, attempt, budget_json, result_json, state_json, executor_json, timeout_seconds, created_at, settled_at FROM runs";

export function getRun(db: Database, id: string): RunRow | null {
  const row = db.query<StoredRun, SQLQueryBindings[]>(`${SELECT} WHERE id = ?`).get(id);
  return row ? RunShape(row) : null;
}

export function listRuns(db: Database, limit = 30): RunRow[] {
  return db
    .query<StoredRun, SQLQueryBindings[]>(`${SELECT} ORDER BY created_at DESC LIMIT ?`)
    .all(limit)
    .map(RunShape);
}

export type RunView = RunRow & {
  readonly pendingApprovalId: string | null;
  readonly pendingTool: string | null;
};

/** Run rows plus the pending approval the UI must render, if any. */
export function withApprovals(db: Database, runs: readonly RunRow[]): RunView[] {
  return runs.map((run) => {
    const row = db
      .query<{ id: string; name: string | null }, SQLQueryBindings[]>(
        "SELECT a.id AS id, t.name AS name FROM approvals a LEFT JOIN tool_calls t ON t.id = a.tool_call_id WHERE a.run_id = ? AND a.status = 'pending' ORDER BY a.requested_at DESC LIMIT 1",
      )
      .get(run.id);
    return { ...run, pendingApprovalId: row?.id ?? null, pendingTool: row?.name ?? null };
  });
}
