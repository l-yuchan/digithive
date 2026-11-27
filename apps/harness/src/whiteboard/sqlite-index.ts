import type { Database, SQLQueryBindings } from "bun:sqlite";
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
  db.transaction((): void => {
    db.run("DELETE FROM whiteboard_fts");
    db.run("DELETE FROM whiteboard_documents");
    const insertDocument = db.query(
      `INSERT INTO whiteboard_documents
         (id,path,kind,title,source_json,status,hash,created_at,updated_at,indexed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    const insertSearch = db.query(
      "INSERT INTO whiteboard_fts (document_id,path,text) VALUES (?,?,?)",
    );
    for (const row of rows) {
      insertDocument.run(
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
  })();
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
