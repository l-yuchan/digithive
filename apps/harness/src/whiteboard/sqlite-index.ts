import { SQLiteError, type Database, type SQLQueryBindings } from "bun:sqlite";
import { isRecord, listMarkdownFiles, readDocumentFile, stableJson } from "./document";
import { WhiteboardListSchema } from "./schema";
import type {
  WhiteboardDocument,
  WhiteboardKind,
  WhiteboardListInput,
  WhiteboardSource,
  WhiteboardSummary,
} from "./types";

/**
 * The parent-owned migration executes this. Together with the reset it is
 * idempotent: index tables are rebuildable from the Markdown files, never content.
 */
export const WHITEBOARD_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS whiteboard_documents (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('record','thread','commitment','watch')),
  title TEXT NOT NULL,
  source_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  indexed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS whiteboard_documents_kind ON whiteboard_documents(kind, updated_at DESC);
CREATE INDEX IF NOT EXISTS whiteboard_documents_updated ON whiteboard_documents(updated_at DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS whiteboard_fts USING fts5(
  document_id UNINDEXED,
  path UNINDEXED,
  text,
  tokenize = 'unicode61'
);
`;

type IndexRow = {
  id: string;
  path: string;
  kind: string;
  title: string;
  source_json: string;
  status: string;
  hash: string;
  created_at: string;
  updated_at: string;
};

const SUMMARY_SELECT =
  "d.id,d.path,d.kind,d.title,d.source_json,d.status,d.hash,d.created_at,d.updated_at";

function kindOf(value: string): WhiteboardKind {
  return value === "record" || value === "thread" || value === "commitment" || value === "watch"
    ? value
    : "thread";
}

function sourceOf(raw: string): WhiteboardSource {
  try {
    const value: unknown = JSON.parse(raw);
    if (isRecord(value)) return value;
  } catch {
    // A stored source that is not JSON is still a searchable document.
  }
  return {};
}

function summaryOf(row: IndexRow): WhiteboardSummary {
  return {
    id: row.id,
    path: row.path,
    kind: kindOf(row.kind),
    title: row.title,
    source: sourceOf(row.source_json),
    status: row.status,
    hash: row.hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sourceText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((entry) => sourceText(entry)).join(" ");
  if (!isRecord(value)) return "";
  // Values are useful provenance, while JSON keys/punctuation are not document content.
  return Object.values(value)
    .map((entry) => sourceText(entry))
    .join(" ");
}

/** Ordinary words, never operator syntax, so Korean and Latin both search safely. */
export function searchExpression(query: string): string | null {
  const tokens = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, 16);
  if (tokens.length === 0) return null;
  return tokens.map((token) => `${token}*`).join(" AND ");
}

/**
 * Discovers files, parses trusted frontmatter and rebuilds both index tables in
 * one transaction. Documents that disappeared lose their rows; FTS is refilled
 * from the same scan so an edited body is searchable immediately.
 */
export function indexWhiteboard(db: Database, root: string): void {
  const indexedAt = new Date().toISOString();
  const rows: IndexRow[] = [];
  const documents = new Map<string, WhiteboardDocument>();
  for (const relative of listMarkdownFiles(root)) {
    const file = readDocumentFile(root, relative);
    if (file === null) continue;
    const document = { ...file.document, path: relative };
    documents.set(relative, document);
    rows.push({
      id: document.id,
      path: relative,
      kind: document.kind,
      title: document.title,
      source_json: stableJson(document.source),
      status: document.status,
      hash: document.hash,
      created_at: document.createdAt,
      updated_at: document.updatedAt,
    });
  }
  // Only the difference between the files and the index is written. A refresh over an
  // unchanged board opens no write transaction at all, which is what keeps a starting
  // worker from colliding with the web process (live SQLITE_BUSY, 2026-11-28).
  const existing = new Map(
    db
      .query<{ id: string; path: string; hash: string }, []>(
        "SELECT id, path, hash FROM whiteboard_documents",
      )
      .all()
      .map((row) => [row.path, row]),
  );
  const wanted = new Set(rows.map((row) => row.path));
  const stale = [...existing.values()].filter((row) => !wanted.has(row.path));
  const changed = rows.filter((row) => existing.get(row.path)?.hash !== row.hash);
  if (stale.length === 0 && changed.length === 0) return;
  // The read above and this write are one decision under the write lock. They are retried
  // while another process holds the lock: measured with a real second process on Bun 1.4.5,
  // an explicit BEGIN IMMEDIATE is refused and did not wait despite `busy_timeout`, so the
  // wait is made here. A locked read is free to re-run; nothing is written until it succeeds.
  let attempt = 0;
  while (true) {
    try {
      db.transaction(writeDifference)();
      return;
    } catch (error) {
      const busy =
        error instanceof SQLiteError &&
        (error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED");
      attempt += 1;
      if (!busy || attempt >= 100) throw error;
      Bun.sleepSync(100);
    }
  }

  function writeDifference(): void {
    const removeDocument = db.query("DELETE FROM whiteboard_documents WHERE path = ?");
    const removeSearch = db.query("DELETE FROM whiteboard_fts WHERE path = ?");
    for (const row of stale) {
      removeDocument.run(row.path);
      removeSearch.run(row.path);
    }
    const upsert = db.query(
      `INSERT INTO whiteboard_documents
         (id,path,kind,title,source_json,status,hash,created_at,updated_at,indexed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(path) DO UPDATE SET id=excluded.id, kind=excluded.kind, title=excluded.title,
         source_json=excluded.source_json, status=excluded.status, hash=excluded.hash,
         created_at=excluded.created_at, updated_at=excluded.updated_at, indexed_at=excluded.indexed_at`,
    );
    const insertSearch = db.query(
      "INSERT INTO whiteboard_fts (document_id,path,text) VALUES (?,?,?)",
    );
    for (const row of changed) {
      removeSearch.run(row.path);
      upsert.run(
        row.id,
        row.path,
        row.kind,
        row.title,
        row.source_json,
        row.status,
        row.hash,
        row.created_at,
        row.updated_at,
        indexedAt,
      );
      const document = documents.get(row.path);
      insertSearch.run(
        row.id,
        row.path,
        `${row.title}\n${document?.text ?? ""}\n${sourceText(document?.source)}\n${row.path}`,
      );
    }
  }
}

/**
 * A SQLite connection that waits for another writer instead of failing instantly. The
 * indexer's writes are short, so the wait only ever bridges the web process's own write; a
 * connection still blocked after the budget reports the real error rather than hanging.
 */
export function withBusyTimeout<T>(db: Database, work: () => T): T {
  db.exec("PRAGMA busy_timeout = 15000");
  try {
    return work();
  } finally {
    db.exec("PRAGMA busy_timeout = 5000");
  }
}

export function queryIndex(db: Database, input: WhiteboardListInput = {}): WhiteboardSummary[] {
  const parsed = WhiteboardListSchema.parse(input);
  const conditions: string[] = [];
  const bindings: SQLQueryBindings[] = [];
  if (parsed.query !== undefined) {
    const expression = searchExpression(parsed.query);
    if (expression !== null) {
      conditions.push(
        "d.id IN (SELECT document_id FROM whiteboard_fts WHERE whiteboard_fts MATCH ?)",
      );
      bindings.push(expression);
    }
  }
  if (parsed.kind !== undefined) {
    conditions.push("d.kind = ?");
    bindings.push(parsed.kind);
  }
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
  bindings.push(parsed.limit ?? 50);
  return db
    .query<IndexRow, SQLQueryBindings[]>(
      `SELECT ${SUMMARY_SELECT}
         FROM whiteboard_documents d${where}
        ORDER BY d.updated_at DESC, d.path ASC
        LIMIT ?`,
    )
    .all(...bindings)
    .map(summaryOf);
}

export function pathForDocument(db: Database, id: string): string | null {
  return (
    db
      .query<{ path: string }, SQLQueryBindings[]>(
        "SELECT path FROM whiteboard_documents WHERE id = ?",
      )
      .get(id)?.path ?? null
  );
}
