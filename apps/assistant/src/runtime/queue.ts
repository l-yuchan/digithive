import type { Database } from "bun:sqlite";
import { z } from "zod";

const RunRow = z.object({
  id: z.string(),
  goal: z.string(),
  executor_kind: z.enum(["pending", "sha256", "script", "agent"]),
  status: z.enum(["queued", "running", "awaiting_approval", "succeeded", "failed", "cancelled", "interrupted"]),
  revision: z.number(),
});
const EventRow = z.object({ seq: z.number(), kind: z.string(), payload_json: z.string() });
export type Run = z.infer<typeof RunRow>;
export type RunEvent = { readonly seq: number; readonly kind: string; readonly payload: unknown };

export class RunConflict extends Error {
  constructor(readonly kind: "missing" | "stale_fence" | "terminal" | "outcome_unknown") {
    super(kind);
    this.name = "RunConflict";
  }
}

function appendEvent(db: Database, runId: string, kind: string, payload: unknown, now: number): void {
  const next = z.object({ value: z.number() }).parse(db.query(
    "SELECT coalesce(max(seq),0)+1 AS value FROM run_events WHERE run_id = ?",
  ).get(runId));
  db.query("INSERT INTO run_events (run_id,seq,kind,payload_json,created_at) VALUES (?,?,?,?,?)")
    .run(runId, next.value, kind, JSON.stringify(payload), new Date(now).toISOString());
}

export function enqueue(
  db: Database,
  input: { readonly requestKey: string; readonly goal: string; readonly executor: "sha256" | "script" | "agent"; readonly conversationId?: string },
  now = Date.now(),
): Run {
  return db.transaction(() => {
    const existing = db.query("SELECT id,goal,executor_kind,status,revision FROM runs WHERE request_key = ?").get(input.requestKey);
    if (existing) return RunRow.parse(existing);
    const id = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const time = new Date(now).toISOString();
    db.query(`INSERT INTO runs
      (id,conversation_id,goal,executor_kind,request_key,status,revision,next_fence,created_at,updated_at)
      VALUES (?,?,?,?,?,'queued',1,2,?,?)`)
      .run(id, input.conversationId ?? null, input.goal, input.executor, input.requestKey, time, time);
    db.query("INSERT INTO attempts (id,run_id,number,fence,status) VALUES (?,?,1,1,'queued')")
      .run(attemptId, id);
    appendEvent(db, id, "queued", {}, now);
    return RunRow.parse(db.query("SELECT id,goal,executor_kind,status,revision FROM runs WHERE id = ?").get(id));
  }).immediate();
}

export function getRun(db: Database, id: string): Run {
  const row = db.query("SELECT id,goal,executor_kind,status,revision FROM runs WHERE id = ?").get(id);
  if (!row) throw new RunConflict("missing");
  return RunRow.parse(row);
}

export function eventsAfter(db: Database, runId: string, after: number): readonly RunEvent[] {
  getRun(db, runId);
  return db.query("SELECT seq,kind,payload_json FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq")
    .all(runId, after)
    .map((item) => {
      const row = EventRow.parse(item);
      const payload: unknown = JSON.parse(row.payload_json);
      return { seq: row.seq, kind: row.kind, payload };
    });
}

export function cancel(db: Database, runId: string, now = Date.now()): boolean {
  return db.transaction(() => {
    const result = db.query(`UPDATE runs SET status = 'cancelled', revision = revision + 1,
      next_fence = next_fence + 1, updated_at = ?
      WHERE id = ? AND status IN ('queued','running','awaiting_approval')`)
      .run(new Date(now).toISOString(), runId);
    if (result.changes !== 1) return false;
    db.query("UPDATE attempts SET status = 'cancelled' WHERE run_id = ? AND status IN ('queued','claimed','running')")
      .run(runId);
    appendEvent(db, runId, "cancelled", {}, now);
    return true;
  }).immediate();
}
