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
  indexed_at TEXT NOT NULL,
  /** The path this document was indexed from before a layout move, for old citations. */
  previous_path TEXT
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
  ensureIndexShape(db);
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
  // A document that moved is recognised by its id: the row keeps the path it left behind so a
  // reference written before the move still resolves (citations name paths, ids do not move).
  const byId = new Map([...existing.values()].map((row) => [row.id, row]));
  const movedTo = new Map(
    rows
      .filter((row) => existing.get(row.path) === undefined && byId.has(row.id))
      .map((row) => [row.id, row.path]),
  );
  const movedFrom = new Map([...movedTo].map(([id, path]) => [path, byId.get(id)?.path ?? null]));
  const stale = [...existing.values()].filter(
    (row) => !wanted.has(row.path) && !movedTo.has(row.id),
  );
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
    // A moved document's old row is removed here, before its new one is inserted, so the
    // id never exists twice inside the same transaction.
    for (const [path, previous] of movedFrom) {
      if (previous !== null && previous !== path) {
        removeDocument.run(previous);
        removeSearch.run(previous);
      }
    }
    const upsert = db.query(
      `INSERT INTO whiteboard_documents
         (id,path,kind,title,source_json,status,hash,created_at,updated_at,indexed_at,previous_path)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(path) DO UPDATE SET id=excluded.id, kind=excluded.kind, title=excluded.title,
         source_json=excluded.source_json, status=excluded.status, hash=excluded.hash,
         created_at=excluded.created_at, updated_at=excluded.updated_at, indexed_at=excluded.indexed_at,
         previous_path=COALESCE(excluded.previous_path, whiteboard_documents.previous_path)`,
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
        movedFrom.get(row.path) ?? null,
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

type RankedRow = IndexRow & { score: number | null; total: number };

export type IndexedHit = WhiteboardSummary & {
  /** BM25 score, lower is better; null when the call was a plain listing. */
  readonly score: number | null;
  /** Documents that matched the whole filter, so the caller knows what it did not see. */
  readonly total: number;
};

/** A group prefix as stored paths use it: no trailing slash, no escaping. */
function prefixOf(group: string): string {
  return group.replace(/\/+$/, "");
}

/**
 * Reads the index with the filesystem filters composed and FTS ranking on top. A query ranks
 * (BM25: title above tags above body) and a listing orders by recency; both answer the total
 * so a caller knows the answer was cut.
 */
export function queryIndex(db: Database, input: WhiteboardListInput = {}): IndexedHit[] {
  const parsed = WhiteboardListSchema.parse(input);
  const conditions: string[] = [];
  const bindings: SQLQueryBindings[] = [];
  const expression = parsed.query === undefined ? null : searchExpression(parsed.query);
  if (expression !== null) {
    conditions.push(
      "d.id IN (SELECT document_id FROM whiteboard_fts WHERE whiteboard_fts MATCH ?)",
    );
    bindings.push(expression);
  }
  if (parsed.kind !== undefined) {
    conditions.push("d.kind = ?");
    bindings.push(parsed.kind);
  }
  if (parsed.group !== undefined && parsed.group.trim().length > 0) {
    // Prefix plus a separator, so a search in "records/in" cannot match "records/inbox".
    conditions.push("(d.path = ? OR d.path LIKE ? ESCAPE '\\')");
    const prefix = prefixOf(parsed.group.trim());
    bindings.push(prefix + ".md", likePrefix(prefix) + "/%");
  }
  if (parsed.source !== undefined) {
    conditions.push("json_extract(d.source_json, '$.type') = ?");
    bindings.push(parsed.source);
  }
  if (parsed.after !== undefined) {
    conditions.push("d.updated_at > ?");
    bindings.push(parsed.after);
  }
  if (parsed.before !== undefined) {
    conditions.push("d.updated_at < ?");
    bindings.push(parsed.before);
  }
  const where = conditions.length > 0 ? " WHERE " + conditions.join(" AND ") : "";
  const total =
    db
      .query<{ n: number }, SQLQueryBindings[]>(
        "SELECT count(*) AS n FROM whiteboard_documents d" + where,
      )
      .get(...bindings)?.n ?? 0;
  const order =
    expression === null
      ? "ORDER BY d.updated_at DESC, d.path ASC"
      : "ORDER BY score, d.updated_at DESC, d.path ASC";
  // The FTS columns are (document_id, path, text); only the body column is weighted.
  const rankJoin =
    expression === null
      ? "NULL AS score"
      : "(SELECT bm25(whiteboard_fts, 0.0, 0.0, 1.0) FROM whiteboard_fts WHERE whiteboard_fts.document_id = d.id AND whiteboard_fts MATCH ?) AS score";
  const params = expression === null ? bindings : [expression, ...bindings];
  return db
    .query<RankedRow, SQLQueryBindings[]>(
      "SELECT " +
        SUMMARY_SELECT +
        ", " +
        rankJoin +
        "\n         FROM whiteboard_documents d" +
        where +
        "\n        " +
        order +
        "\n        LIMIT ?",
    )
    .all(...params, parsed.limit ?? 50)
    .map((row) => ({ ...summaryOf(row), score: row.score, total }));
}

/**
 * The index is rebuildable, so a shape the previous build wrote is replaced by rebuilding it
 * rather than by a schema migration: content lives in the Markdown files, never here.
 */
function ensureIndexShape(db: Database): void {
  const columns = db
    .query<{ name: string }, []>("SELECT name FROM pragma_table_info('whiteboard_documents')")
    .all()
    .map((column) => column.name);
  if (columns.length === 0 || columns.includes("previous_path")) return;
  db.exec("DROP TABLE whiteboard_documents");
  db.exec("DROP TABLE whiteboard_fts");
  db.exec(WHITEBOARD_SCHEMA_SQL);
}

/** Escapes the LIKE wildcards in a literal prefix so a path is matched exactly. */
function likePrefix(value: string): string {
  return value.replace(/[%_\\]/g, (match) => "\\" + match);
}

export type GroupCount = {
  readonly path: string;
  readonly count: number;
  readonly updatedAt: string | null;
};

/** Directories one level under `prefix`, each with how many documents sit beneath it. */
export function groupCounts(db: Database, prefix: string): GroupCount[] {
  const trimmed = prefix.trim().replace(/^\/+/, "");
  const base = trimmed.length === 0 ? "" : prefixOf(trimmed) + "/";
  const rows = db
    .query<{ path: string; updated_at: string }, [string]>(
      "SELECT path, updated_at FROM whiteboard_documents WHERE path LIKE ? ESCAPE '\\'",
    )
    .all(likePrefix(base) + "%");
  const groups = new Map<string, GroupCount>();
  for (const row of rows) {
    const rest = row.path.slice(base.length);
    const slash = rest.indexOf("/");
    if (slash <= 0) continue;
    const child = base + rest.slice(0, slash);
    const existing = groups.get(child);
    groups.set(
      child,
      existing === undefined
        ? { path: child, count: 1, updatedAt: row.updated_at }
        : {
            path: child,
            count: existing.count + 1,
            updatedAt:
              existing.updatedAt !== null && existing.updatedAt > row.updated_at
                ? existing.updatedAt
                : row.updated_at,
          },
    );
  }
  return [...groups.values()].toSorted((left, right) => left.path.localeCompare(right.path));
}

/** Documents beneath a prefix; the prefix itself counts when it names a document. */
export function countUnder(db: Database, prefix: string): number {
  const base = prefixOf(prefix);
  return (
    db
      .query<{ n: number }, [string, string]>(
        "SELECT count(*) AS n FROM whiteboard_documents WHERE path = ? OR path LIKE ? ESCAPE '\\'",
      )
      .get(base + ".md", likePrefix(base) + "/%")?.n ?? 0
  );
}

/**
 * Resolves paths that may predate a layout move: a document is found by its current path or
 * by the path it was reindexed from, because a citation names the path it was written with.
 */
export function idsForPaths(db: Database, paths: readonly string[]): Map<string, string> {
  const found = new Map<string, string>();
  if (paths.length === 0) return found;
  const wanted = new Set(paths);
  const rows = db
    .query<{ id: string; path: string; previous_path: string | null }, []>(
      "SELECT id, path, previous_path FROM whiteboard_documents",
    )
    .all();
  for (const row of rows) {
    if (wanted.has(row.path)) found.set(row.path, row.id);
    if (row.previous_path !== null && wanted.has(row.previous_path))
      found.set(row.previous_path, row.id);
  }
  return found;
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
