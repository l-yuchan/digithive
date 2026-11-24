import type { Database, SQLQueryBindings } from "bun:sqlite";
import { appendEntry, listEntries, type Entry } from "./sessions";

function entryById(db: Database, sessionId: string, entryId: string): Entry | null {
  return listEntries(db, sessionId).find((candidate) => candidate.id === entryId) ?? null;
}

export function getLeaf(db: Database, sessionId: string): string | null {
  const row = db.query<{ leaf_id: string | null }, SQLQueryBindings[]>("SELECT leaf_id FROM sessions WHERE id = ?").get(sessionId);
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
  input: { readonly sessionId: string; readonly entryId: string; readonly text: string; readonly now?: number },
): EditResult {
  const original = entryById(db, input.sessionId, input.entryId);
  if (!original) throw new Error("entry_not_found");
  if (original.role !== "user") throw new Error("not_a_user_message");
  const entry = appendEntry(db, {
    sessionId: input.sessionId,
    parentId: original.parentId,
    kind: original.kind,
    role: "user",
    parts: [{ type: "text", text: input.text }],
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  setLeaf(db, input.sessionId, entry.id);
  return { entry, replaced: original };
}

/**
 * Regenerating an assistant answer starts a new sibling under the same parent
 * user message; the previous answer remains readable in the tree.
 */
export function regeneratePoint(db: Database, input: { readonly sessionId: string; readonly entryId: string }): { parentId: string | null; userText: string } {
  const all = listEntries(db, input.sessionId);
  const target = all.find((entry) => entry.id === input.entryId);
  if (!target) throw new Error("entry_not_found");
  const parent = target.parentId ? all.find((entry) => entry.id === target.parentId) : null;
  if (!parent || parent.role !== "user") throw new Error("not_regenerable");
  const userText = parent.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
  setLeaf(db, input.sessionId, parent.id);
  return { parentId: parent.id, userText };
}

/** Copies the ancestor chain of `entryId` into a brand-new session. */
export function forkSession(
  db: Database,
  input: { readonly sessionId: string; readonly entryId: string; readonly title: string; readonly now?: number },
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
      parts: entry.parts,
      now,
    });
    parent = created.id;
    last = created.id;
  }
  setLeaf(db, id, last);
  return { sessionId: id, entries: chain.length };
}

export function searchSessions(db: Database, query: string, limit = 20): { id: string; title: string }[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];
  try {
    if (trimmed.length >= 3) {
      return db
        .query<{ id: string; title: string }, SQLQueryBindings[]>(
          `SELECT DISTINCT s.id AS id, s.title AS title FROM sessions s
           JOIN entries_fts f ON f.session_id = s.id
           WHERE s.deleted_at IS NULL AND entries_fts MATCH ?
           LIMIT ?`,
        )
        .all(`"${trimmed.replace(/"/g, '""')}"`, limit);
    }
  } catch {
    // fall through to LIKE for short or unparsable queries
  }
  const like = `%${trimmed}%`;
  return db
    .query<{ id: string; title: string }, SQLQueryBindings[]>(
      `SELECT DISTINCT s.id AS id, s.title AS title FROM sessions s
       LEFT JOIN entries e ON e.session_id = s.id
       WHERE s.deleted_at IS NULL AND (s.title LIKE ? OR e.payload_json LIKE ?)
       LIMIT ?`,
    )
    .all(like, like, limit);
}
