import type { Database } from "bun:sqlite";
import { z } from "zod";
import { RunConflict } from "./queue";

const Attempt = z.object({
  id: z.string(),
  run_id: z.string(),
  fence: z.number(),
  goal: z.string(),
  executor_kind: z.string(),
  lease_until: z.string(),
});
export type ClaimedAttempt = z.infer<typeof Attempt>;
const LEASE_MS = 30_000;

export function claim(db: Database, workerId: string, now = Date.now()): ClaimedAttempt | undefined {
  return db.transaction(() => {
    const row = db.query(`SELECT a.id,a.run_id,a.fence,r.goal,r.executor_kind
      FROM attempts a JOIN runs r ON r.id = a.run_id
      WHERE a.status = 'queued' AND r.status = 'queued'
      ORDER BY r.created_at LIMIT 1`).get();
    if (!row) return undefined;
    const selected = z.object({
      id: z.string(), run_id: z.string(), fence: z.number(),
      goal: z.string(), executor_kind: z.string(),
    }).parse(row);
    const until = new Date(now + LEASE_MS).toISOString();
    db.query("UPDATE attempts SET status = 'claimed',worker_id = ?,lease_until = ?,heartbeat_at = ? WHERE id = ?")
      .run(workerId, until, new Date(now).toISOString(), selected.id);
    db.query("UPDATE runs SET status = 'running',revision = revision + 1,updated_at = ? WHERE id = ?")
      .run(new Date(now).toISOString(), selected.run_id);
    return Attempt.parse({ ...selected, lease_until: until });
  }).immediate();
}

export function start(db: Database, attempt: ClaimedAttempt, workerId: string, now = Date.now()): boolean {
  const result = db.query(`UPDATE attempts SET status = 'running'
    WHERE id = ? AND fence = ? AND worker_id = ? AND status = 'claimed' AND lease_until > ?
    AND EXISTS (SELECT 1 FROM runs WHERE id = ? AND status = 'running' AND next_fence = ?)`)
    .run(attempt.id, attempt.fence, workerId, new Date(now).toISOString(), attempt.run_id, attempt.fence + 1);
  return result.changes === 1;
}

export function heartbeat(db: Database, attempt: ClaimedAttempt, workerId: string, now = Date.now()): boolean {
  const result = db.query(`UPDATE attempts SET heartbeat_at = ?, lease_until = ?
    WHERE id = ? AND fence = ? AND worker_id = ? AND status = 'running' AND lease_until > ?
    AND EXISTS (SELECT 1 FROM runs WHERE id = ? AND status = 'running' AND next_fence = ?)`)
    .run(new Date(now).toISOString(), new Date(now + LEASE_MS).toISOString(), attempt.id, attempt.fence,
      workerId, new Date(now).toISOString(), attempt.run_id, attempt.fence + 1);
  return result.changes === 1;
}

export function complete(
  db: Database, attempt: ClaimedAttempt, workerId: string,
  result: { readonly status: "succeeded" | "failed"; readonly output: string }, now = Date.now(),
): void {
  db.transaction(() => {
    const current = db.query(`SELECT a.status,a.lease_until,a.worker_id,r.status AS run_status,r.next_fence
      FROM attempts a JOIN runs r ON r.id = a.run_id WHERE a.id = ? AND a.fence = ?`)
      .get(attempt.id, attempt.fence);
    const row = z.object({
      status: z.string(), lease_until: z.string().nullable(), worker_id: z.string().nullable(),
      run_status: z.string(), next_fence: z.number(),
    }).parse(current);
    if (row.status !== "running" || row.worker_id !== workerId || row.run_status !== "running" ||
      row.next_fence !== attempt.fence + 1 || !row.lease_until || Date.parse(row.lease_until) <= now) {
      throw new RunConflict("stale_fence");
    }
    db.query("UPDATE attempts SET status = ?,lease_until = NULL WHERE id = ?")
      .run(result.status, attempt.id);
    db.query("UPDATE runs SET status = ?,revision = revision + 1,updated_at = ? WHERE id = ?")
      .run(result.status, new Date(now).toISOString(), attempt.run_id);
    const seq = z.object({ value: z.number() }).parse(db.query(
      "SELECT coalesce(max(seq),0)+1 AS value FROM run_events WHERE run_id = ?",
    ).get(attempt.run_id)).value;
    db.query("INSERT INTO run_events (run_id,seq,kind,payload_json,created_at) VALUES (?,?,?,?,?)")
      .run(attempt.run_id, seq, result.status, JSON.stringify({ output: result.output }), new Date(now).toISOString());
  }).immediate();
}

export function pauseForApproval(
  db: Database, attempt: ClaimedAttempt, workerId: string,
  action: { readonly actionHash: string; readonly args: unknown }, now = Date.now(),
): string {
  return db.transaction(() => {
    const row = db.query(`SELECT a.status,a.worker_id,a.lease_until,r.status AS run_status,r.next_fence
      FROM attempts a JOIN runs r ON r.id = a.run_id WHERE a.id = ? AND a.fence = ?`)
      .get(attempt.id, attempt.fence);
    const state = z.object({
      status: z.string(), worker_id: z.string().nullable(), lease_until: z.string().nullable(),
      run_status: z.string(), next_fence: z.number(),
    }).parse(row);
    if (state.status !== "running" || state.worker_id !== workerId || state.run_status !== "running" ||
      state.next_fence !== attempt.fence + 1 || !state.lease_until || Date.parse(state.lease_until) <= now) {
      throw new RunConflict("stale_fence");
    }
    const toolCallId = crypto.randomUUID();
    db.query("INSERT INTO tool_calls (id,run_id,attempt_id,action_hash,status,args_json) VALUES (?,?,?,?,'planned',?)")
      .run(toolCallId, attempt.run_id, attempt.id, action.actionHash, JSON.stringify(action.args));
    db.query("UPDATE attempts SET status = 'interrupted', lease_until = NULL WHERE id = ?").run(attempt.id);
    db.query("UPDATE runs SET status = 'awaiting_approval',next_fence = next_fence + 1,revision = revision + 1,updated_at = ? WHERE id = ?")
      .run(new Date(now).toISOString(), attempt.run_id);
    const seq = z.object({ value: z.number() }).parse(db.query(
      "SELECT coalesce(max(seq),0)+1 AS value FROM run_events WHERE run_id = ?",
    ).get(attempt.run_id)).value;
    db.query("INSERT INTO run_events (run_id,seq,kind,payload_json,created_at) VALUES (?,?,?,?,?)")
      .run(attempt.run_id, seq, "awaiting_approval", JSON.stringify({ toolCallId }), new Date(now).toISOString());
    return toolCallId;
  }).immediate();
}

export function recoverExpired(db: Database, now = Date.now()): readonly string[] {
  return db.transaction(() => {
    const expired = db.query(`SELECT a.id,a.run_id FROM attempts a JOIN runs r ON r.id = a.run_id
      WHERE a.status IN ('claimed','running') AND r.status = 'running' AND a.lease_until <= ?`)
      .all(new Date(now).toISOString())
      .map((row) => z.object({ id: z.string(), run_id: z.string() }).parse(row));
    for (const attempt of expired) {
      db.query("UPDATE attempts SET status = 'interrupted' WHERE id = ?").run(attempt.id);
      db.query("UPDATE tool_calls SET status = 'outcome_unknown' WHERE attempt_id = ? AND status = 'consumed'")
        .run(attempt.id);
      db.query("UPDATE runs SET status = 'interrupted',next_fence = next_fence + 1,revision = revision + 1,updated_at = ? WHERE id = ?")
        .run(new Date(now).toISOString(), attempt.run_id);
      const seq = z.object({ value: z.number() }).parse(db.query(
        "SELECT coalesce(max(seq),0)+1 AS value FROM run_events WHERE run_id = ?",
      ).get(attempt.run_id)).value;
      db.query("INSERT INTO run_events (run_id,seq,kind,payload_json,created_at) VALUES (?,?,?,?,?)")
        .run(attempt.run_id, seq, "interrupted", "{}", new Date(now).toISOString());
    }
    return expired.map((attempt) => attempt.run_id);
  }).immediate();
}
