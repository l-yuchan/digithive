import type { Database } from "bun:sqlite";
import type { EventLog } from "../../events/log";
import { leaseExpiry } from "../../core/run-state";

export function ownsLease(db: Database, id: string, owner: string | null, now: number): boolean {
  return db.query("SELECT id FROM runs WHERE id=? AND status='running' AND lease_owner=? AND lease_expires_at>?")
    .get(id, owner, new Date(now).toISOString()) !== null;
}

export function keepLease(
  db: Database,
  events: EventLog,
  run: { readonly id: string; readonly leaseOwner: string | null },
  leaseMs: number,
  totalMs: number,
  now: () => number,
): { readonly signal: AbortSignal; readonly close: () => void } {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new Error("work_timeout")), totalMs);
  const heartbeat = setInterval(() => {
    const time = now();
    const changed = db.query("UPDATE runs SET lease_expires_at=? WHERE id=? AND status='running' AND lease_owner=? AND lease_expires_at>?")
      .run(leaseExpiry(time, leaseMs), run.id, run.leaseOwner, new Date(time).toISOString());
    if (changed.changes === 0) controller.abort(new Error("lease_lost"));
    else events.append({ kind: "run.heartbeat", runId: run.id, payload: { owner: run.leaseOwner }, now: time });
  }, Math.max(1, Math.floor(leaseMs / 3)));
  return { signal: controller.signal, close: () => { clearTimeout(deadline); clearInterval(heartbeat); } };
}
