import type { Database, SQLQueryBindings } from "bun:sqlite";
import { z } from "zod";
import { parseEntryEvents, type ConversationEvent } from "./contracts";
import { ok } from "node:assert/strict";

export type Entry = {
  readonly id: string;
  readonly sessionId: string;
  readonly parentId: string | null;
  readonly kind: string;
  readonly role: string | null;
  readonly status: string | null;
  readonly events: readonly ConversationEvent[];
  readonly createdAt: string;
  readonly seq: number;
};

const EntryRow = z.object({
  id: z.string(),
  session_id: z.string(),
  parent_id: z.string().nullable(),
  kind: z.string(),
  role: z.string().nullable(),
  status: z.string().nullable(),
  payload_json: z.string(),
  created_at: z.string(),
  seq: z.number(),
});

const SessionRow = z.object({
  id: z.string(),
  title: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Session = z.infer<typeof SessionRow>;

function toEntry(row: z.infer<typeof EntryRow>): Entry {
  return {
    id: row.id,
    sessionId: row.session_id,
    parentId: row.parent_id,
    kind: row.kind,
    role: row.role,
    status: row.status,
    events: parseEntryEvents(row.payload_json),
    createdAt: row.created_at,
    seq: row.seq,
  };
}

export function createSession(db: Database, title: string, now = Date.now()): Session {
  const id = crypto.randomUUID();
  const iso = new Date(now).toISOString();
  db.query("INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
    id,
    title.slice(0, 200) || "새 대화",
    iso,
    iso,
  );
  return { id, title: title.slice(0, 200) || "새 대화", created_at: iso, updated_at: iso };
}

export function getSession(db: Database, id: string): Session | null {
  const row = db
    .query(
      "SELECT id, title, created_at, updated_at FROM sessions WHERE id = ? AND deleted_at IS NULL",
    )
    .get(id);
  return row ? SessionRow.parse(row) : null;
}

export function listSessions(db: Database): Session[] {
  return db
    .query(
      "SELECT id, title, created_at, updated_at FROM sessions WHERE deleted_at IS NULL ORDER BY updated_at DESC",
    )
    .all()
    .map((row) => SessionRow.parse(row));
}

export function renameSession(
  db: Database,
  id: string,
  title: string,
  now = Date.now(),
): Session | null {
  const trimmed = title.trim().slice(0, 200);
  if (trimmed.length === 0) return null;
  db.query("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(
    trimmed,
    new Date(now).toISOString(),
    id,
  );
  return getSession(db, id);
}

/** Soft delete: the row and its entries stay readable, live runs are cancelled. */
export function softDeleteSession(
  db: Database,
  id: string,
  now = Date.now(),
): { cancelledRuns: number } {
  const iso = new Date(now).toISOString();
  const result = db.transaction(() => {
    const live = db
      .query<
        {
          id: string;
        },
        SQLQueryBindings[]
      >(
        "SELECT id FROM runs WHERE session_id = ? AND status IN ('queued','running','awaiting_approval')",
      )
      .all(id);
    for (const run of live) {
      db.query(
        "UPDATE runs SET status = 'cancelled', cancel_intent = 'policy', settled_at = ? WHERE id = ?",
      ).run(iso, run.id);
    }
    db.query("UPDATE sessions SET deleted_at = ?, leaf_id = NULL WHERE id = ?").run(iso, id);
    return live.length;
  });
  return { cancelledRuns: result() };
}

export function appendEntry(
  db: Database,
  input: {
    readonly sessionId: string;
    readonly parentId?: string | null;
    readonly kind: string;
    readonly role?: string | null;
    readonly status?: string | null;
    readonly events: readonly ConversationEvent[];
    readonly now?: number;
  },
): Entry {
  const seqRow = db
    .query<
      {
        next: number;
      },
      SQLQueryBindings[]
    >("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM entries WHERE session_id = ?")
    .get(input.sessionId);
  ok(seqRow, "sequence query returns one aggregate row");
  const id = crypto.randomUUID();
  const createdAt = new Date(input.now ?? Date.now()).toISOString();
  const status = input.status ?? "complete";
  db.query(
    "INSERT INTO entries (id, session_id, parent_id, kind, role, status, payload_json, created_at, seq) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(
    id,
    input.sessionId,
    input.parentId ?? null,
    input.kind,
    input.role ?? null,
    status,
    JSON.stringify({ events: input.events }),
    createdAt,
    seqRow.next,
  );
  db.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(createdAt, input.sessionId);
  indexEvents(db, id, input.sessionId, input.events);
  return {
    id,
    sessionId: input.sessionId,
    parentId: input.parentId ?? null,
    kind: input.kind,
    role: input.role ?? null,
    status,
    events: input.events,
    createdAt,
    seq: seqRow.next,
  };
}

/**
 * Streaming progress, stored as it arrives so a reconnect or reload can show what
 * the reader already saw. The search index is written once, at completion.
 */
export function saveEntryEvents(
  db: Database,
  entryId: string,
  events: readonly ConversationEvent[],
): void {
  db.query("UPDATE entries SET payload_json = ? WHERE id = ?").run(
    JSON.stringify({ events }),
    entryId,
  );
}

export function updateEntryEvents(
  db: Database,
  entryId: string,
  events: readonly ConversationEvent[],
  status: "complete" | "aborted" | "failed",
  sessionId?: string,
): void {
  db.query("UPDATE entries SET payload_json = ?, status = ? WHERE id = ?").run(
    JSON.stringify({ events }),
    status,
    entryId,
  );
  if (sessionId) indexEvents(db, entryId, sessionId, events);
}

function indexEvents(
  db: Database,
  entryId: string,
  sessionId: string,
  events: readonly ConversationEvent[],
): void {
  const text = events
    .filter((event): event is Extract<ConversationEvent, { type: "text" }> => event.type === "text")
    .map((event) => event.text)
    .join("\n")
    .trim();
  try {
    db.query("DELETE FROM entries_fts WHERE entry_id = ?").run(entryId);
    if (text.length >= 3)
      db.query("INSERT INTO entries_fts (entry_id, session_id, text) VALUES (?, ?, ?)").run(
        entryId,
        sessionId,
        text,
      );
  } catch {
    // an older database without the FTS table keeps working; search falls back to LIKE
  }
}

export function listEntries(db: Database, sessionId: string): Entry[] {
  return db
    .query(
      "SELECT id, session_id, parent_id, kind, role, status, payload_json, created_at, seq FROM entries WHERE session_id = ? ORDER BY seq",
    )
    .all(sessionId)
    .map((row) => toEntry(EntryRow.parse(row)));
}

export function historyMessages(
  db: Database,
  sessionId: string,
): { role: "user" | "assistant"; content: string }[] {
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const entry of listEntries(db, sessionId)) {
    if (entry.kind !== "message") continue;
    if (entry.role !== "user" && entry.role !== "assistant") continue;
    const text = entry.events
      .filter(
        (event): event is Extract<ConversationEvent, { type: "text" }> => event.type === "text",
      )
      .map((event) => event.text)
      .join("");
    if (text.length === 0) continue;
    out.push({ role: entry.role, content: text });
  }
  return out;
}
