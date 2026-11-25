import type { Database } from "bun:sqlite";
import type { EventLog } from "../../events/log";
import { getRun } from "./record";

/**
 * Durable user cancellation. A running executor observes either the cancelled
 * status directly or its signal poll and settles as cancelled, never as a
 * timeout or host restart. Pending approvals are closed in the same write.
 */
export function cancelRun(
  deps: { readonly db: Database; readonly events: EventLog },
  runId: string,
  now = Date.now(),
): { readonly status: string; readonly changed: boolean } | null {
  return deps.db
    .transaction(() => {
      const run = getRun(deps.db, runId);
      if (!run) return null;
      if (["succeeded", "failed", "cancelled", "interrupted"].includes(run.status))
        return { status: run.status, changed: false };
      const iso = new Date(now).toISOString();
      deps.db
        .query(
          "UPDATE approvals SET status = 'expired', decided_at = ? WHERE run_id = ? AND status = 'pending'",
        )
        .run(iso, runId);
      deps.db
        .query(
          "UPDATE tool_calls SET status = 'interrupted', ended_at = ? WHERE run_id = ? AND status IN ('pending','running')",
        )
        .run(iso, runId);
      deps.db
        .query(
          `UPDATE runs SET status = 'cancelled', cancel_intent = 'user', lease_owner = NULL,
                  lease_expires_at = NULL, settled_at = ?, result_json = COALESCE(result_json, ?)
            WHERE id = ? AND status IN ('queued','running','awaiting_approval')`,
        )
        .run(iso, JSON.stringify({ error: "cancelled" }), runId);
      deps.events.append({
        kind: "run.cancelled",
        runId,
        sessionId: run.sessionId,
        payload: { reason: "user" },
        now,
      });
      return { status: "cancelled", changed: true };
    })
    .immediate();
}
