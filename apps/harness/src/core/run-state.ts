import type { Database, SQLQueryBindings } from "bun:sqlite";

export const RUN_STATUSES = [
  "queued",
  "running",
  "awaiting_approval",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

/** Cancellation always records who asked, so recovery never guesses (#11856). */
export const CANCEL_INTENTS = ["user", "timeout", "host_restart", "policy", "superseded"] as const;
export type CancelIntent = (typeof CANCEL_INTENTS)[number];

const TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ["running", "cancelled"],
  running: ["awaiting_approval", "succeeded", "failed", "cancelled", "interrupted"],
  awaiting_approval: ["running", "cancelled", "interrupted"],
  succeeded: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: RunStatus): boolean {
  return TRANSITIONS[status].length === 0 && status !== "queued";
}

export const LEASE_MS = 45_000;

export function leaseExpiry(now: number, ms = LEASE_MS): string {
  return new Date(now + ms).toISOString();
}

export function isLeaseExpired(expiresAt: string | null, now = Date.now()): boolean {
  if (!expiresAt) return true;
  const at = Date.parse(expiresAt);
  return Number.isNaN(at) || at <= now;
}

/**
 * Settlement rule: a run that holds no live lease is `interrupted`, never
 * `running` forever (#9711, #14329). Returns the settled run ids.
 */
export function settleExpiredRuns(db: Database, now = Date.now(), owner?: string): string[] {
  const rows = db
    .query<{ id: string; status: string; lease_expires_at: string | null }, SQLQueryBindings[]>(
      "SELECT id, status, lease_expires_at FROM runs WHERE status = 'running'",
    )
    .all();
  const settled: string[] = [];
  const update = db.query(
    "UPDATE runs SET status = 'interrupted', cancel_intent = 'host_restart', settled_at = ? WHERE id = ? AND status = 'running'",
  );
  for (const row of rows) {
    if (owner && row.lease_expires_at !== null && !isLeaseExpired(row.lease_expires_at, now))
      continue;
    if (!isLeaseExpired(row.lease_expires_at, now)) continue;
    update.run(new Date(now).toISOString(), row.id);
    settled.push(row.id);
  }
  return settled;
}
