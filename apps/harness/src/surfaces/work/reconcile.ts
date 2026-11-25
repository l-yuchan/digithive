import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { EventLog } from "../../events/log";
import { isLeaseExpired } from "../../core/run-state";

/** Expires approvals nobody answered, and settles runs whose lease died. */
export function reconcileWork(
  db: Database,
  events: EventLog,
  now = Date.now(),
  ttlMs = 30 * 60_000,
): { expiredApprovals: number; interrupted: number } {
  return db
    .transaction(() => {
      const stale = db
        .query<{ id: string; run_id: string }, SQLQueryBindings[]>(
          "SELECT id, run_id FROM approvals WHERE status = 'pending' AND requested_at <= ?",
        )
        .all(new Date(now - ttlMs).toISOString());
      for (const approval of stale) {
        db.query("UPDATE approvals SET status = 'expired', decided_at = ? WHERE id = ?").run(
          new Date(now).toISOString(),
          approval.id,
        );
        db.query(
          "UPDATE runs SET status = 'queued' WHERE id = ? AND status = 'awaiting_approval'",
        ).run(approval.run_id);
        events.append({
          kind: "approval.expired",
          runId: approval.run_id,
          payload: { approvalId: approval.id },
          now,
        });
      }
      const live = db
        .query<{ id: string; lease_expires_at: string | null }, SQLQueryBindings[]>(
          "SELECT id, lease_expires_at FROM runs WHERE status = 'running'",
        )
        .all();
      let interrupted = 0;
      for (const run of live) {
        if (!isLeaseExpired(run.lease_expires_at, now)) continue;
        db.query(
          "UPDATE runs SET status = 'interrupted', cancel_intent = 'host_restart', settled_at = ? WHERE id = ?",
        ).run(new Date(now).toISOString(), run.id);
        events.append({
          kind: "run.interrupted",
          runId: run.id,
          payload: { reason: "lease_expired" },
          now,
        });
        interrupted += 1;
      }
      return { expiredApprovals: stale.length, interrupted };
    })
    .immediate();
}
