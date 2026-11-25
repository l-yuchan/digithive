import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { EventLog } from "../../events/log";
import type { RunRow } from "./record";

export type RunOutcome = "succeeded" | "paused" | "failed" | "interrupted" | "cancelled";

export function abortMessage(signal: AbortSignal): string | null {
  if (!signal.aborted) return null;
  return signal.reason instanceof Error ? signal.reason.message : String(signal.reason);
}

export function dbCancelled(db: Database, runId: string): boolean {
  const row = db
    .query<{ status: string; cancel_intent: string | null }, SQLQueryBindings[]>(
      "SELECT status, cancel_intent FROM runs WHERE id = ?",
    )
    .get(runId);
  return row?.status === "cancelled" || row?.cancel_intent === "user";
}

/** Single settlement path for agent, builtin and script executors. */
export function settle(
  db: Database,
  events: EventLog,
  run: RunRow,
  status: Exclude<RunOutcome, "paused">,
  payload: Record<string, unknown>,
  now: number,
  detail?: string,
): void {
  if (status === "cancelled") {
    const changed = db
      .query(
        `UPDATE runs SET status = 'cancelled', cancel_intent = 'user', lease_owner = NULL,
                lease_expires_at = NULL, settled_at = ?, result_json = ?
          WHERE id = ? AND status IN ('running','awaiting_approval')`,
      )
      .run(new Date(now).toISOString(), JSON.stringify(payload), run.id);
    if (changed.changes === 0) return;
  } else {
    const changed = db
      .query(
        "UPDATE runs SET status = ?, lease_owner = NULL, lease_expires_at = NULL, settled_at = ?, result_json = ? WHERE id = ? AND status = 'running' AND lease_owner = ?",
      )
      .run(status, new Date(now).toISOString(), JSON.stringify(payload), run.id, run.leaseOwner);
    if (changed.changes === 0) return;
  }
  events.append({
    kind:
      status === "succeeded"
        ? "run.settled"
        : status === "failed"
          ? "run.failed"
          : status === "cancelled"
            ? "run.cancelled"
            : "run.interrupted",
    runId: run.id,
    sessionId: run.sessionId,
    payload: detail === undefined ? payload : { ...payload, detail },
    now,
  });
  if (run.parentRunId) {
    events.append({
      kind: "run.progress",
      runId: run.parentRunId,
      sessionId: run.sessionId,
      payload: {
        childRunId: run.id,
        status,
        summary: summaryOf(payload).slice(0, 200),
      },
      now,
    });
  }
}

function summaryOf(payload: Record<string, unknown>): string {
  const text = payload["text"];
  if (typeof text === "string") return text;
  const error = payload["error"];
  return typeof error === "string" ? error : "";
}
