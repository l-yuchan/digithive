import type { Database } from "bun:sqlite";
import { z } from "zod";

const Kind = z.enum(["fact", "preference", "inference", "interest", "commitment"]);
export type MemoryKind = z.infer<typeof Kind>;

const Memory = z.object({
  id: z.string(),
  statement: z.string(),
  kind: Kind,
  status: z.enum(["active", "superseded", "deleted"]),
  evidence_ref: z.string(),
  revision: z.number(),
  context_epoch: z.number(),
  created_at: z.string(),
});
export type Memory = z.infer<typeof Memory>;

export class MemoryError extends Error {
  constructor(readonly kind: "missing" | "stale_revision" | "invalid" | "deleted") {
    super(kind);
    this.name = "MemoryError";
  }
}

export function contextEpoch(db: Database): number {
  const row = db.query("SELECT value_json FROM settings WHERE key = 'context_epoch'").get();
  const parsed = z.object({ value_json: z.string() }).safeParse(row);
  if (!parsed.success) return 0;
  const value = z.coerce.number().int().nonnegative().safeParse(JSON.parse(parsed.data.value_json));
  return value.success ? value.data : 0;
}

function bumpEpoch(db: Database, now: number): number {
  const next = contextEpoch(db) + 1;
  db.query(`INSERT INTO settings (key,value_json,revision,updated_by,updated_at) VALUES ('context_epoch',?,1,'system',?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
      revision = settings.revision + 1, updated_at = excluded.updated_at`)
    .run(String(next), new Date(now).toISOString());
  return next;
}

function indexMemory(db: Database, memory: Memory): void {
  db.query("INSERT INTO memory_index (memory_id, statement) VALUES (?,?)").run(memory.id, memory.statement);
}

function unindexMemory(db: Database, id: string): void {
  db.query("DELETE FROM memory_index WHERE memory_id = ?").run(id);
}

function row(db: Database, id: string): Memory {
  const found = db.query(`SELECT id,statement,kind,status,evidence_ref,revision,context_epoch,created_at
    FROM memories WHERE id = ?`).get(id);
  if (!found) throw new MemoryError("missing");
  return Memory.parse(found);
}

export function addMemory(
  db: Database,
  input: { readonly statement: string; readonly kind: MemoryKind; readonly evidenceRef: string },
  now = Date.now(),
): Memory {
  const statement = input.statement.trim();
  if (statement.length === 0 || statement.length > 2_000 || input.evidenceRef.trim() === "") {
    throw new MemoryError("invalid");
  }
  return db.transaction(() => {
    const epoch = bumpEpoch(db, now);
    const id = crypto.randomUUID();
    db.query(`INSERT INTO memories (id,statement,kind,status,evidence_ref,revision,context_epoch,created_at)
      VALUES (?,?,?,'active',?,1,?,?)`)
      .run(id, statement, input.kind, input.evidenceRef.trim(), epoch, new Date(now).toISOString());
    const created = row(db, id);
    indexMemory(db, created);
    return created;
  }).immediate();
}

/**
 * A correction creates a new revision, marks the previous one superseded and
 * links them, then invalidates the search index for the old wording. A stale
 * revision is refused so two edits cannot silently overwrite each other.
 */
export function correctMemory(
  db: Database,
  id: string,
  input: { readonly revision: number; readonly correction: string },
  now = Date.now(),
): Memory {
  return db.transaction(() => {
    const current = row(db, id);
    if (current.status !== "active") {
      throw new MemoryError(current.status === "deleted" ? "deleted" : "stale_revision");
    }
    if (current.revision !== input.revision) throw new MemoryError("stale_revision");
    const correction = input.correction.trim();
    if (correction.length === 0 || correction.length > 2_000) throw new MemoryError("invalid");
    const epoch = bumpEpoch(db, now);
    const nextId = crypto.randomUUID();
    db.query(`INSERT INTO memories (id,statement,kind,status,evidence_ref,revision,context_epoch,created_at)
      VALUES (?,?,?,'active',?,?,?,?)`)
      .run(nextId, correction, current.kind, current.evidence_ref, current.revision + 1, epoch, new Date(now).toISOString());
    db.query("UPDATE memories SET status = 'superseded' WHERE id = ?").run(id);
    db.query("INSERT INTO memory_edges (from_id,to_id,relation) VALUES (?,?,'supersedes')").run(nextId, id);
    unindexMemory(db, id);
    const created = row(db, nextId);
    indexMemory(db, created);
    return created;
  }).immediate();
}

export function deleteMemory(
  db: Database, id: string, input: { readonly revision: number }, now = Date.now(),
): { readonly deleted: true; readonly contextEpoch: number } {
  return db.transaction(() => {
    const current = row(db, id);
    if (current.status !== "active") {
      throw new MemoryError(current.status === "deleted" ? "deleted" : "stale_revision");
    }
    if (current.revision !== input.revision) throw new MemoryError("stale_revision");
    db.query("UPDATE memories SET status = 'deleted' WHERE id = ?").run(id);
    unindexMemory(db, id);
    const epoch = bumpEpoch(db, now);
    db.query(`INSERT INTO audit_log (id,actor,action,target_id,metadata_json,created_at) VALUES (?,?,?,?,?,?)`)
      .run(crypto.randomUUID(), "user", "memory.delete", id, JSON.stringify({ revision: current.revision }),
        new Date(now).toISOString());
    return { deleted: true as const, contextEpoch: epoch };
  }).immediate();
}

export function listMemories(db: Database, status: "active" | "all" = "active"): readonly Memory[] {
  const rows = status === "active"
    ? db.query(`SELECT id,statement,kind,status,evidence_ref,revision,context_epoch,created_at
        FROM memories WHERE status = 'active' ORDER BY created_at DESC`).all()
    : db.query(`SELECT id,statement,kind,status,evidence_ref,revision,context_epoch,created_at
        FROM memories ORDER BY created_at DESC`).all();
  return rows.map((item) => Memory.parse(item));
}

export function supersedesOf(db: Database, id: string): readonly string[] {
  return db.query("SELECT to_id FROM memory_edges WHERE from_id = ? AND relation = 'supersedes'").all(id)
    .map((item) => z.object({ to_id: z.string() }).parse(item).to_id);
}
