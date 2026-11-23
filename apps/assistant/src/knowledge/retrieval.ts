import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { MemoryKind } from "./memory";

export type Retrieved = {
  readonly id: string;
  readonly statement: string;
  readonly kind: MemoryKind;
  readonly revision: number;
  readonly evidenceRef: string;
};

const Row = z.object({
  id: z.string(), statement: z.string(),
  kind: z.enum(["fact", "preference", "inference", "interest", "commitment"]),
  revision: z.number(), evidence_ref: z.string(),
});

export type SearchOptions = {
  readonly query: string;
  readonly kinds?: readonly MemoryKind[];
  readonly limit?: number;
  readonly minRevision?: number;
};

/** FTS over active memories only: a superseded or deleted statement can never
 * come back through search. Kinds are filtered in SQL so an interest can never
 * answer a commitment query by accident. */
export function search(db: Database, options: SearchOptions): readonly Retrieved[] {
  const terms = options.query
    .split(/\s+/)
    .map((term) => term.replace(/["*:^()-]/g, "").trim())
    .filter((term) => term.length > 0)
    .map((term) => `"${term}"`);
  if (terms.length === 0) return [];
  const limit = Math.min(options.limit ?? 8, 32);
  const kinds = options.kinds ?? [];
  const kindSql = kinds.length === 0 ? "" : ` AND m.kind IN (${kinds.map(() => "?").join(",")})`;
  const params: (string | number)[] = [terms.join(" OR "), ...kinds, limit];
  const rows = db.query(`SELECT m.id, m.statement, m.kind, m.revision, m.evidence_ref
    FROM memory_index f JOIN memories m ON m.id = f.memory_id
    WHERE memory_index MATCH ? AND m.status = 'active'${kindSql}
    ORDER BY m.revision DESC LIMIT ?`).all(...params);
  return rows.map((item) => {
    const parsed = Row.parse(item);
    return {
      id: parsed.id, statement: parsed.statement, kind: parsed.kind,
      revision: parsed.revision, evidenceRef: parsed.evidence_ref,
    };
  }).filter((item) => options.minRevision === undefined || item.revision >= options.minRevision);
}

/** Only active interests: the caller decides what to do with them, and nothing
 * here promotes an interest into a commitment. */
export function interests(db: Database, limit = 5): readonly Retrieved[] {
  const rows = db.query(`SELECT id,statement,kind,revision,evidence_ref FROM memories
    WHERE status = 'active' AND kind = 'interest' ORDER BY created_at DESC LIMIT ?`).all(limit);
  return rows.map((item) => {
    const parsed = Row.parse(item);
    return {
      id: parsed.id, statement: parsed.statement, kind: parsed.kind,
      revision: parsed.revision, evidenceRef: parsed.evidence_ref,
    };
  });
}

export function isStale(db: Database, id: string, revision: number): boolean {
  const row = db.query("SELECT revision, status FROM memories WHERE id = ?").get(id);
  const parsed = z.object({ revision: z.number(), status: z.string() }).safeParse(row);
  if (!parsed.success) return true;
  return parsed.data.status !== "active" || parsed.data.revision !== revision;
}
