import type { Database, SQLQueryBindings } from "bun:sqlite";
import { z } from "zod";
import { ok } from "node:assert/strict";

export const EVENT_KINDS = [
  "session.created",
  "session.renamed",
  "session.deleted",
  "turn.started",
  "turn.aborted",
  "message.delta",
  "tool.started",
  "tool.result",
  "tool.denied",
  "tool.timeout",
  "approval.requested",
  "approval.decided",
  "approval.expired",
  "run.queued",
  "run.started",
  "run.heartbeat",
  "run.settled",
  "run.failed",
  "run.interrupted",
  "run.cancelled",
  "context.edited",
  "usage.recorded",
  "provider.retry",
  "provider.fallback",
  "integration.sync_state",
  "workflow.created",
  "workflow.updated",
  "workflow.deleted",
  "workflow.run",
  "schedule.created",
  "schedule.updated",
  "schedule.deleted",
  // Legacy kinds: stored rows stay readable, but nothing emits these any more.
  // `message.*` and `turn.settled` ended with the event-per-part stream;
  // `context.compacted` was superseded by the `compaction` entry and `context.edited`;
  // `schedule.run`/`schedule.enabled` ended with v10; `budget.threshold`,
  // `tool.progress` and `sdk.capability` were declared but never emitted.
  "turn.settled",
  "message.started",
  "message.part",
  "message.completed",
  "message.aborted",
  "tool.progress",
  "context.compacted",
  "budget.threshold",
  "sdk.capability",
  "schedule.run",
  "schedule.enabled",
] as const;

const EventRow = z.object({
  seq: z.number(),
  run_id: z.string().nullable(),
  session_id: z.string().nullable(),
  kind: z.string(),
  payload_json: z.string(),
  created_at: z.string(),
});

export type LoggedEvent = {
  readonly seq: number;
  readonly runId: string | null;
  readonly sessionId: string | null;
  readonly kind: string;
  readonly payload: unknown;
  readonly createdAt: string;
};

export type AppendInput = {
  readonly kind: string;
  readonly payload: unknown;
  readonly runId?: string | null;
  readonly sessionId?: string | null;
  readonly now?: number;
};

export type Listener = (event: LoggedEvent) => void;

function toLogged(row: z.infer<typeof EventRow>): LoggedEvent {
  let payload: unknown = null;
  try {
    payload = JSON.parse(row.payload_json);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    payload = { unreadable: true };
  }
  return {
    seq: row.seq,
    runId: row.run_id,
    sessionId: row.session_id,
    kind: row.kind,
    payload,
    createdAt: row.created_at,
  };
}

/** Delivers one event; a subscriber's failure is reported, never propagated. */
function notify(listener: Listener, event: LoggedEvent): void {
  try {
    listener(event);
  } catch (error) {
    console.error("event listener failed", error);
  }
}

/**
 * Persisted events carry a global sequence. Subscribers drain the database,
 * including rows appended by other processes, and deduplicate local wakeups.
 */
export class EventLog {
  readonly #db: Database;
  readonly #listeners = new Set<Listener>();

  constructor(db: Database) {
    this.#db = db;
  }

  append(input: AppendInput): LoggedEvent {
    const createdAt = new Date(input.now ?? Date.now()).toISOString();
    const row = this.#db
      .query(
        `INSERT INTO events (run_id, session_id, kind, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)
         RETURNING seq, run_id, session_id, kind, payload_json, created_at`,
      )
      .get(
        input.runId ?? null,
        input.sessionId ?? null,
        input.kind,
        JSON.stringify(input.payload ?? null),
        createdAt,
      );
    const event = toLogged(EventRow.parse(row));
    // A subscriber that fails to render one event must not fail the write that
    // already committed it, nor stop the other subscribers from seeing it.
    for (const listener of this.#listeners) notify(listener, event);
    return event;
  }

  after(seq: number, sessionId?: string): LoggedEvent[] {
    const rows = sessionId
      ? this.#db
          .query(
            "SELECT seq, run_id, session_id, kind, payload_json, created_at FROM events WHERE seq > ? AND session_id = ? ORDER BY seq",
          )
          .all(seq, sessionId)
      : this.#db
          .query(
            "SELECT seq, run_id, session_id, kind, payload_json, created_at FROM events WHERE seq > ? ORDER BY seq",
          )
          .all(seq);
    return rows.map((row) => toLogged(EventRow.parse(row)));
  }

  lastSeq(): number {
    const row = this.#db
      .query<{ seq: number }, SQLQueryBindings[]>("SELECT COALESCE(MAX(seq), 0) AS seq FROM events")
      .get();
    ok(row, "sequence query returns one aggregate row");
    return row.seq;
  }

  subscribe(listener: Listener, after = this.lastSeq()): () => void {
    let cursor = after;
    const drain = () => {
      for (const event of this.after(cursor)) {
        if (event.seq <= cursor) continue;
        // The cursor moves first: a listener that throws has still been offered the
        // event, and leaving the cursor behind would re-offer it forever, while
        // advancing it after a throw would skip the rest of the backlog.
        cursor = event.seq;
        notify(listener, event);
      }
    };
    const deliver: Listener = () => drain();
    this.#listeners.add(deliver);
    const poll = setInterval(drain, 50);
    return () => {
      clearInterval(poll);
      this.#listeners.delete(deliver);
    };
  }
}
