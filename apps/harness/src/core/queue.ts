import type { Database, SQLQueryBindings } from "bun:sqlite";
import { z } from "zod";

/**
 * What the owner said while a turn was still answering. It is not an interruption:
 * a queued message runs on its own turn once the current one settles, so two turns
 * never share one working tree and the second answer sees the first.
 */
export type QueuedMessage = {
  readonly id: string;
  readonly sessionId: string;
  readonly text: string;
  readonly createdAt: string;
};

const QueueRow = z.object({
  id: z.string(),
  session_id: z.string(),
  text: z.string(),
  created_at: z.string(),
});

function toMessage(row: z.infer<typeof QueueRow>): QueuedMessage {
  return { id: row.id, sessionId: row.session_id, text: row.text, createdAt: row.created_at };
}

export function enqueue(
  db: Database,
  sessionId: string,
  text: string,
  now = Date.now(),
): QueuedMessage {
  const message: QueuedMessage = {
    id: crypto.randomUUID(),
    sessionId,
    text,
    createdAt: new Date(now).toISOString(),
  };
  db.query("INSERT INTO session_queue (id, session_id, text, created_at) VALUES (?,?,?,?)").run(
    message.id,
    sessionId,
    text,
    message.createdAt,
  );
  return message;
}

export function listQueue(db: Database, sessionId: string): QueuedMessage[] {
  return db
    .query(
      "SELECT id, session_id, text, created_at FROM session_queue WHERE session_id = ? ORDER BY created_at, rowid",
    )
    .all(sessionId)
    .map((row) => toMessage(QueueRow.parse(row)));
}

/** Removes one queued message; returns false when it was not there (already taken or cancelled). */
export function dequeue(db: Database, sessionId: string, id: string): boolean {
  const removed = db
    .query("DELETE FROM session_queue WHERE id = ? AND session_id = ?")
    .run(id, sessionId);
  return removed.changes > 0;
}

/** Takes the next queued message, so two drains on one session cannot run the same text. */
export function takeNext(db: Database, sessionId: string): QueuedMessage | null {
  const row = db
    .query(
      "SELECT id, session_id, text, created_at FROM session_queue WHERE session_id = ? ORDER BY created_at, rowid LIMIT 1",
    )
    .get(sessionId);
  if (!row) return null;
  const next = toMessage(QueueRow.parse(row));
  return dequeue(db, sessionId, next.id) ? next : null;
}

export function queuePaused(db: Database, sessionId: string): boolean {
  const row = db
    .query<{ paused: number }, SQLQueryBindings[]>(
      "SELECT queue_paused AS paused FROM sessions WHERE id = ?",
    )
    .get(sessionId);
  return row?.paused === 1;
}

export function setQueuePaused(db: Database, sessionId: string, paused: boolean): void {
  db.query("UPDATE sessions SET queue_paused = ? WHERE id = ?").run(paused ? 1 : 0, sessionId);
}

/** A turn is in flight when its run is still live; a paused queue waits on the owner. */
export function turnInFlight(db: Database, sessionId: string): boolean {
  const row = db
    .query<{ live: number }, SQLQueryBindings[]>(
      "SELECT COUNT(*) AS live FROM runs WHERE session_id = ? AND status IN ('queued','running','awaiting_approval')",
    )
    .get(sessionId);
  return (row?.live ?? 0) > 0;
}

/**
 * A removed conversation keeps its queued text readable but never runs it: its
 * turns were cancelled with the session.
 */
export function dropQueue(db: Database, sessionId: string): number {
  return db.query("DELETE FROM session_queue WHERE session_id = ?").run(sessionId).changes;
}
