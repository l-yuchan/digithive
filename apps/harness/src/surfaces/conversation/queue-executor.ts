import type { Database } from "bun:sqlite";
import type { EventLog } from "../../events/log";
import {
  enqueue,
  listQueue,
  queuePaused,
  setQueuePaused,
  takeNext,
  turnInFlight,
  type QueuedMessage,
} from "../../core/queue";

/**
 * The conversation queue's decisions, apart from the turn runner that acts on them.
 *
 * Everything that decides *whether* a queued message runs — paused after a failure,
 * a turn still in flight, a name still to be chosen — lives here and takes its
 * effects as parameters, so the ordering is provable without starting a model turn.
 * The surface supplies the effects: it starts a turn, asks the app to name the
 * conversation, or reports that the queue is paused.
 */
export type QueueExecutor = {
  readonly db: Database;
  readonly events: EventLog;
};

export type DrainContext = {
  /** Whether the conversation may still be named before the next question runs. */
  readonly allowTitle: boolean;
  readonly paused: boolean;
  readonly idle: boolean;
  readonly shouldName: boolean;
  readonly startTitle: (sessionId: string) => boolean;
  readonly claim: (sessionId: string, text: string) => void;
};

export function enqueueMessage(
  { db, events }: QueueExecutor,
  sessionId: string,
  text: string,
): QueuedMessage {
  const queued = enqueue(db, sessionId, text);
  events.append({
    kind: "queue.enqueued",
    sessionId,
    payload: { id: queued.id, text: queued.text },
  });
  return queued;
}

export function pauseQueue(
  db: Database,
  events: EventLog,
  sessionId: string,
  reason: string,
): void {
  setQueuePaused(db, sessionId, true);
  events.append({ kind: "queue.paused", sessionId, payload: { reason } });
}

/**
 * Runs the next queued message when nothing else owns the conversation; the name of
 * a first exchange is chosen before the next question is taken, because the name
 * must describe only that exchange. Returns whether a turn started.
 */
export function drainQueue(
  { db, events }: QueueExecutor,
  sessionId: string,
  context: DrainContext,
): boolean {
  if (context.paused || !context.idle) return false;
  if (context.allowTitle && context.shouldName && context.startTitle(sessionId)) return false;
  const next = takeNext(db, sessionId);
  if (!next) return false;
  events.append({
    kind: "queue.dequeued",
    sessionId,
    payload: { id: next.id, text: next.text },
  });
  context.claim(sessionId, next.text);
  return true;
}

export function cancelQueued(
  { db, events }: QueueExecutor,
  sessionId: string,
  queueId: string,
): boolean {
  const removed = db
    .query("DELETE FROM session_queue WHERE id = ? AND session_id = ?")
    .run(queueId, sessionId);
  if (removed.changes === 0) return false;
  events.append({ kind: "queue.cancelled", sessionId, payload: { id: queueId } });
  return true;
}

/** Everything the queue holds, across conversations; used to decide what to resume. */
export function queuedSessions(db: Database): string[] {
  return db
    .query<{ session_id: string }, []>(
      "SELECT DISTINCT q.session_id FROM session_queue q JOIN sessions s ON s.id = q.session_id WHERE s.deleted_at IS NULL",
    )
    .all()
    .map((row) => row.session_id);
}

/** Turns that are live for this conversation right now. */
export function conversationBusy(db: Database, sessionId: string): boolean {
  return turnInFlight(db, sessionId);
}

export { listQueue, queuePaused };
