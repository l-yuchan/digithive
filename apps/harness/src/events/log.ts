import type { Database } from "bun:sqlite";
import { z } from "zod";

export const EVENT_KINDS = [
  "session.created",
  "session.renamed",
  "session.deleted",
  "turn.started",
  "turn.settled",
  "turn.aborted",
  "message.started",
  "message.delta",
  "message.part",
  "message.completed",
  "message.aborted",
  "tool.started",
  "tool.progress",
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
  "context.compacted",
  "context.edited",
  "usage.recorded",
  "budget.threshold",
  "provider.retry",
  "provider.fallback",
  "integration.sync_state",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

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
  readonly kind: EventKind | string;
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

/**
 * The canonical event log. State changes and their events are written in the
 * same transaction by the caller (`append` accepts a writer), and every event
 * carries a monotonic global seq so a client can resume with `after=<seq>`
 * without gaps.
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
      .get(input.runId ?? null, input.sessionId ?? null, input.kind, JSON.stringify(input.payload ?? null), createdAt);
    const event = toLogged(EventRow.parse(row));
    for (const listener of this.#listeners) listener(event);
    return event;
  }

  after(seq: number, sessionId?: string): LoggedEvent[] {
    const rows = sessionId
      ? this.#db.query("SELECT seq, run_id, session_id, kind, payload_json, created_at FROM events WHERE seq > ? AND session_id = ? ORDER BY seq").all(seq, sessionId)
      : this.#db.query("SELECT seq, run_id, session_id, kind, payload_json, created_at FROM events WHERE seq > ? ORDER BY seq").all(seq);
    return rows.map((row) => toLogged(EventRow.parse(row)));
  }

  lastSeq(): number {
    const row = this.#db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get() as { seq: number };
    return row.seq;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}
