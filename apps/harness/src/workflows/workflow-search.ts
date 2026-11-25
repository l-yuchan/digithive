import type { Database, SQLQueryBindings } from "bun:sqlite";
import { WorkflowError } from "./workflow-store";
import { WorkflowSearchSchema, type WorkflowSearchInput } from "./workflow-types";

export type WorkflowHit = { readonly id: string; readonly score: number | null };

const MIN_TRIGRAM = 3;

function keywordHits(db: Database, keyword: string, limit: number): WorkflowHit[] {
  const tokens = [
    ...new Set(
      keyword
        .toLowerCase()
        .split(/\s+/)
        .filter((token) => token.length > 0),
    ),
  ];
  if (tokens.length === 0) return [];
  const where = tokens
    .map(() => "(instr(lower(title), ?) > 0 OR instr(lower(instruction), ?) > 0)")
    .join(" AND ");
  const bindings: SQLQueryBindings[] = [];
  for (const token of tokens) bindings.push(token, token);
  bindings.push(limit);
  return db
    .query<{ id: string }, SQLQueryBindings[]>(
      `SELECT id FROM workflows WHERE ${where} ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(...bindings)
    .map((row) => ({ id: row.id, score: null }));
}

function regexHits(db: Database, pattern: string, limit: number): WorkflowHit[] {
  let matcher: RegExp;
  try {
    matcher = new RegExp(pattern, "i");
  } catch (error) {
    throw new WorkflowError("search_invalid_regex", {
      message: error instanceof Error ? error.message : "parse_failed",
    });
  }
  const rows = db
    .query<{ id: string; text: string }, SQLQueryBindings[]>(
      "SELECT id, title || '\n' || instruction AS text FROM workflows ORDER BY updated_at DESC LIMIT 1000",
    )
    .all();
  const hits: WorkflowHit[] = [];
  for (const row of rows) {
    if (matcher.test(row.text)) hits.push({ id: row.id, score: null });
    if (hits.length >= limit) break;
  }
  return hits;
}

function bm25Hits(db: Database, query: string, limit: number): WorkflowHit[] {
  if (query.trim().length < MIN_TRIGRAM) {
    throw new WorkflowError("search_query_too_short", { mode: "bm25", minLength: MIN_TRIGRAM });
  }
  try {
    return db
      .query<{ workflow_id: string; score: number }, SQLQueryBindings[]>(
        `SELECT workflow_id, bm25(workflows_fts) AS score
           FROM workflows_fts WHERE workflows_fts MATCH ? ORDER BY score LIMIT ?`,
      )
      .all(query, limit)
      .map((row) => ({ id: row.workflow_id, score: row.score }));
  } catch (error) {
    throw new WorkflowError("search_invalid_bm25", {
      message: error instanceof Error ? error.message : "query_failed",
    });
  }
}

/**
 * Deferred loading: one mode at a time. keyword is AND over terms, regex runs over
 * title+instruction, bm25 uses the trigram index (three characters is the tokenizer
 * minimum, so a shorter query is reported instead of silently matching nothing).
 */
export function searchWorkflowIds(db: Database, raw: unknown): WorkflowHit[] {
  const input: WorkflowSearchInput = WorkflowSearchSchema.parse(raw);
  if (input.keyword !== undefined) return keywordHits(db, input.keyword, input.limit);
  if (input.regex !== undefined) return regexHits(db, input.regex, input.limit);
  if (input.bm25 !== undefined) return bm25Hits(db, input.bm25, input.limit);
  return db
    .query<{ id: string }, SQLQueryBindings[]>(
      "SELECT id FROM workflows ORDER BY updated_at DESC LIMIT ?",
    )
    .all(input.limit)
    .map((row) => ({ id: row.id, score: null }));
}
