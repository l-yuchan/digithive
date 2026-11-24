import type { Database, SQLQueryBindings } from "bun:sqlite";
import { z } from "zod";

export const MEMORY_KINDS = ["interest", "fact", "hypothesis", "commitment", "delegation"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

const MemoryRow = z.object({
  id: z.string(),
  kind: z.string(),
  text: z.string(),
  source_json: z.string(),
  superseded_by: z.string().nullable(),
  created_at: z.string(),
});

export type Memory = {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  readonly source: unknown;
  readonly supersededBy: string | null;
  readonly createdAt: string;
};

function toMemory(row: z.infer<typeof MemoryRow>): Memory {
  let source: unknown = {};
  try {
    source = JSON.parse(row.source_json);
  } catch {
    source = {};
  }
  return {
    id: row.id,
    kind: row.kind,
    text: row.text,
    source,
    supersededBy: row.superseded_by,
    createdAt: row.created_at,
  };
}

export function remember(
  db: Database,
  input: {
    readonly kind: MemoryKind;
    readonly text: string;
    readonly source?: unknown;
    readonly now?: number;
  },
): Memory {
  const id = crypto.randomUUID();
  const iso = new Date(input.now ?? Date.now()).toISOString();
  db.query(
    "INSERT INTO memories (id, kind, text, source_json, created_at, updated_at) VALUES (?,?,?,?,?,?)",
  ).run(id, input.kind, input.text.slice(0, 4_000), JSON.stringify(input.source ?? {}), iso, iso);
  return {
    id,
    kind: input.kind,
    text: input.text,
    source: input.source ?? {},
    supersededBy: null,
    createdAt: iso,
  };
}

export function listMemories(db: Database, includeSuperseded = false): Memory[] {
  const rows = includeSuperseded
    ? db
        .query(
          "SELECT id, kind, text, source_json, superseded_by, created_at FROM memories ORDER BY created_at DESC",
        )
        .all()
    : db
        .query(
          "SELECT id, kind, text, source_json, superseded_by, created_at FROM memories WHERE superseded_by IS NULL ORDER BY created_at DESC",
        )
        .all();
  return rows.map((row) => toMemory(MemoryRow.parse(row)));
}

/**
 * Correction keeps the old row and points it at the replacement, so a later
 * answer can still explain what changed and when.
 */
export function correctMemory(
  db: Database,
  input: { readonly id: string; readonly text: string; readonly now?: number },
): Memory | null {
  const existing = db
    .query<{ id: string; kind: string; source_json: string }, SQLQueryBindings[]>(
      "SELECT id, kind, source_json FROM memories WHERE id = ?",
    )
    .get(input.id);
  if (!existing) return null;
  const created = remember(db, {
    kind: z.enum(MEMORY_KINDS).parse(existing.kind),
    text: input.text,
    source: JSON.parse(existing.source_json),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  db.query("UPDATE memories SET superseded_by = ?, updated_at = ? WHERE id = ?").run(
    created.id,
    new Date(input.now ?? Date.now()).toISOString(),
    existing.id,
  );
  return created;
}

/** Recall only returns live (not superseded) memories that actually match. */
export function recallMemories(db: Database, query: string, limit = 8): Memory[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];
  const rows = db
    .query(
      "SELECT id, kind, text, source_json, superseded_by, created_at FROM memories WHERE superseded_by IS NULL AND (text LIKE ? OR kind = ?) ORDER BY updated_at DESC LIMIT ?",
    )
    .all(`%${trimmed}%`, trimmed, limit);
  return rows.map((row) => toMemory(MemoryRow.parse(row)));
}
