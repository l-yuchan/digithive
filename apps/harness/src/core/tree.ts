import type { z } from "zod";

/** One row of the session query, as the session mapper reads it. */
type InferSessionRow = z.infer<typeof SessionRow>;
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { appendEntry, listEntries, toSession } from "./sessions";
import type { Entry, Session, SessionRow } from "./sessions";
import { conversationText } from "./contracts";

function entryById(db: Database, sessionId: string, entryId: string): Entry | null {
  return listEntries(db, sessionId).find((candidate) => candidate.id === entryId) ?? null;
}

export function getLeaf(db: Database, sessionId: string): string | null {
  const row = db
    .query<{ leaf_id: string | null }, SQLQueryBindings[]>(
      "SELECT leaf_id FROM sessions WHERE id = ?",
    )
    .get(sessionId);
  return row?.leaf_id ?? null;
}

export function setLeaf(db: Database, sessionId: string, entryId: string | null): void {
  db.query("UPDATE sessions SET leaf_id = ? WHERE id = ?").run(entryId, sessionId);
}

/**
 * The visible conversation is the ancestor chain of the leaf. Branching never
 * deletes anything: entries keep their parent, and only the leaf moves.
 */
export function pathEntries(db: Database, sessionId: string, leafId?: string | null): Entry[] {
  const all = listEntries(db, sessionId);
  const byId = new Map(all.map((entry) => [entry.id, entry]));
  let current = leafId === undefined ? getLeaf(db, sessionId) : leafId;
  if (!current) {
    const last = all.at(-1);
    return last ? [last] : [];
  }
  const chain: Entry[] = [];
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current)) break;
    seen.add(current);
    const entry = byId.get(current);
    if (!entry) break;
    chain.push(entry);
    current = entry.parentId;
  }
  return chain.toReversed();
}

/** The newest descendant of an entry, so switching branches lands on a complete turn. */
export function deepestDescendant(db: Database, sessionId: string, entryId: string): string {
  const all = listEntries(db, sessionId);
  const children = new Map<string | null, typeof all>();
  for (const entry of all) {
    const key = entry.parentId;
    const list = children.get(key) ?? [];
    list.push(entry);
    children.set(key, list);
  }
  let current = entryId;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const next = (children.get(current) ?? []).at(-1);
    if (!next) break;
    current = next.id;
  }
  return current;
}

export function siblings(db: Database, sessionId: string, entryId: string): Entry[] {
  const all = listEntries(db, sessionId);
  const target = all.find((entry) => entry.id === entryId);
  if (!target) return [];
  return all.filter((entry) => entry.parentId === target.parentId);
}

export type EditResult = { readonly entry: Entry; readonly replaced: Entry };

/**
 * Editing a user message creates a sibling with the same parent, so the original
 * message stays in the tree and the new branch becomes the leaf.
 */
export function editUserMessage(
  db: Database,
  input: {
    readonly sessionId: string;
    readonly entryId: string;
    readonly text: string;
    readonly now?: number;
  },
): EditResult {
  const original = entryById(db, input.sessionId, input.entryId);
  if (!original) throw new Error("entry_not_found");
  if (original.role !== "user") throw new Error("not_a_user_message");
  const entry = appendEntry(db, {
    sessionId: input.sessionId,
    parentId: original.parentId,
    kind: original.kind,
    role: "user",
    events: [{ type: "text", id: 0, text: input.text }],
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  setLeaf(db, input.sessionId, entry.id);
  return { entry, replaced: original };
}

/**
 * Regenerating an assistant answer starts a new sibling under the same parent
 * user message; the previous answer remains readable in the tree.
 */
export function regeneratePoint(
  db: Database,
  input: { readonly sessionId: string; readonly entryId: string },
): { parentId: string | null; userText: string } {
  const all = listEntries(db, input.sessionId);
  const target = all.find((entry) => entry.id === input.entryId);
  if (!target) throw new Error("entry_not_found");
  const parent = target.parentId ? all.find((entry) => entry.id === target.parentId) : null;
  if (!parent || parent.role !== "user") throw new Error("not_regenerable");
  const userText = conversationText(parent.events);
  setLeaf(db, input.sessionId, parent.id);
  return { parentId: parent.id, userText };
}

/** Copies the ancestor chain of `entryId` into a brand-new session. */
export function forkSession(
  db: Database,
  input: {
    readonly sessionId: string;
    readonly entryId: string;
    readonly title: string;
    readonly now?: number;
  },
): { sessionId: string; entries: number } {
  const chain = pathEntries(db, input.sessionId, input.entryId);
  if (chain.length === 0) throw new Error("empty_path");
  const now = input.now ?? Date.now();
  const id = crypto.randomUUID();
  const iso = new Date(now).toISOString();
  db.query("INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
    id,
    input.title.slice(0, 200) || "분기",
    iso,
    iso,
  );
  let parent: string | null = null;
  let last: string | null = null;
  for (const entry of chain) {
    const created = appendEntry(db, {
      sessionId: id,
      parentId: parent,
      kind: entry.kind,
      role: entry.role,
      status: entry.status,
      events: entry.events,
      now,
    });
    parent = created.id;
    last = created.id;
  }
  setLeaf(db, id, last);
  return { sessionId: id, entries: chain.length };
}

export function searchSessions(db: Database, query: string, limit = 20): Session[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];
  const columns = "s.id,s.title,s.title_source,s.created_at,s.updated_at";
  // A trigram index matches a contiguous phrase, so a multi-word search is one phrase
  // per word joined with AND: `내일 회의` must find both words wherever they sit, the
  // way a search reader expects, instead of the exact adjacent string only.
  const tokens = trimmed.split(/\s+/).filter((token) => token.length > 0);
  const match = tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(" AND ");
  // A word index matches words, so a two-character word like 회의 is searchable; the
  // three-character floor belonged to the trigram index this index replaced. A word
  // seeking its own start (`준비물` for `준비물을`) is a prefix query, since Korean
  // attaches its particles to the noun.
  try {
    if (trimmed.length > 0) {
      return db
        .query<InferSessionRow, SQLQueryBindings[]>(
          `SELECT ${columns} FROM sessions s
           WHERE s.deleted_at IS NULL AND (s.title LIKE ? OR s.id IN
             (SELECT session_id FROM entries_fts WHERE entries_fts MATCH ?))
           LIMIT ?`,
        )
        .all(`%${trimmed}%`, match, limit)
        .map(toSession);
    }
  } catch {
    // fall through to LIKE for an unparsable query
  }
  const like = `%${trimmed}%`;
  return db
    .query<z.infer<typeof SessionRow>, SQLQueryBindings[]>(
      `SELECT DISTINCT ${columns} FROM sessions s
       LEFT JOIN entries e ON e.session_id = s.id
       WHERE s.deleted_at IS NULL
         AND (s.title LIKE ? OR EXISTS (
           SELECT 1 FROM json_each(e.payload_json, '$.events') AS part
           WHERE json_extract(part.value, '$.text') LIKE ?
              OR json_extract(part.value, '$.title') LIKE ?
              OR json_extract(part.value, '$.body') LIKE ?
         ))
       LIMIT ?`,
    )
    .all(like, like, like, like, limit)
    .map(toSession);
}
