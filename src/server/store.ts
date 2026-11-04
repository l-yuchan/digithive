import type { Database } from "bun:sqlite";
import type {
  Development,
  Entry,
  EvaluationEntry,
  HistoryEvent,
  Preparation,
  Settings,
  Suggestion,
} from "../shared";

// Data access over bun:sqlite. Tables map 1:1 to shared types; structured
// fields (context, why_now, ...) are stored as JSON columns and decoded on
// read. Two server-internal extensions exist beyond the shared types:
// developments persist `addresses_obstacle_entry_ids` (curator-declared
// obstacle linkage, contract CreateDevelopmentRequest) and suggestions carry
// an internal `hold_reason` used by the release pass (never serialized).

export type DevelopmentRow = Development & { addresses_obstacle_entry_ids: string[] };
export type SuggestionRow = Suggestion & { hold_reason: string | null };

export function suggestionView(s: SuggestionRow): Suggestion {
  const { hold_reason: _hold_reason, ...view } = s;
  return { ...view, why_now: { ...view.why_now, obstacle_link: view.why_now.obstacle_link.replace(/^stored obstacle:/, "기록된 장애물:") } };
}

export type TableName =
  | "entries"
  | "preferences"
  | "sources"
  | "developments"
  | "suggestions"
  | "triage_events"
  | "preparations"
  | "history_events"
  | "evaluations"
  | "backup_snapshots";

interface TableDef {
  columns: readonly string[];
  json: readonly string[];
}

const TABLES: Record<TableName, TableDef> = {
  entries: {
    columns: ["id", "kind", "text", "original_text", "status", "provenance", "context", "source_ids", "derived_from_entry_id", "created_at", "updated_at", "version", "scope"],
    json: ["context", "source_ids"],
  },
  preferences: {
    columns: ["id", "key", "scope", "value", "status", "provenance", "created_at", "updated_at", "version"],
    json: [],
  },
  sources: {
    columns: ["id", "title", "url", "publisher", "published_at", "evidence_summary", "created_at"],
    json: [],
  },
  developments: {
    columns: ["id", "source_id", "occurred_at", "summary", "content", "time_sensitivity", "deadline", "addresses_obstacle_entry_ids", "created_at"],
    json: ["addresses_obstacle_entry_ids"],
  },
  suggestions: {
    columns: ["id", "entry_id", "development_id", "status", "strength", "score", "matcher", "why_now", "hold_until", "surfaced_at", "response", "created_at", "updated_at", "hold_reason"],
    json: ["why_now", "response"],
  },
  triage_events: {
    columns: ["id", "development_id", "entry_id", "outcome", "reason", "score", "at"],
    json: [],
  },
  preparations: {
    columns: ["id", "request", "delegation_id", "suggestion_id", "scope", "max_steps", "status", "produced_actions", "result_summary", "model", "created_at", "updated_at"],
    json: ["produced_actions"],
  },
  history_events: {
    columns: ["id", "entity_type", "entity_id", "action", "actor", "summary", "details", "at"],
    json: ["details"],
  },
  evaluations: {
    columns: ["id", "date", "condition", "context_recovery_minutes", "search_minutes", "task_restart_minutes", "review_correction_minutes", "assistant_management_minutes", "interruption_recovery_minutes", "opportunities_offered", "opportunities_accepted", "missed_high_value", "unwanted_interruptions", "grounding_errors", "correction_events", "cancellation_violations", "approval_boundary_violations", "usefulness_rating", "burden_rating", "control_rating", "confidence_rating", "notes", "created_at", "updated_at"],
    json: [],
  },
  backup_snapshots: {
    columns: ["id", "created_at", "file_name", "size_bytes"],
    json: [],
  },
};

export type SqlParam = string | number | null;

export interface Clause {
  sql: string;
  params: SqlParam[];
}

export const eq = (col: string, v: SqlParam): Clause => ({ sql: `${col} = ?`, params: [v] });
export const likeClause = (col: string, v: string): Clause => ({
  sql: `${col} LIKE ? ESCAPE '\\'`,
  params: [v],
});
export const gte = (col: string, v: SqlParam): Clause => ({ sql: `${col} >= ?`, params: [v] });
export const lte = (col: string, v: SqlParam): Clause => ({ sql: `${col} <= ?`, params: [v] });
export const inCol = (col: string, vs: readonly SqlParam[]): Clause =>
  vs.length === 0
    ? { sql: "0", params: [] }
    : { sql: `${col} IN (${vs.map(() => "?").join(", ")})`, params: [...vs] };

export function likeEscape(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function defaultSettings(): Settings {
  return {
    quiet_mode: false,
    quiet_until: null,
    delivery: "immediate",
    digest_time: "09:00",
    timezone: DEFAULT_TIMEZONE,
    focus_windows: [],
  };
}

function enc(v: unknown): unknown {
  if (v === undefined) return null;
  if (v !== null && typeof v === "object") return JSON.stringify(v);
  return v;
}

function checkColumns(table: TableName, keys: readonly string[]): void {
  const def = TABLES[table];
  for (const k of keys) if (!def.columns.includes(k)) throw new Error(`unknown column ${table}.${k}`);
}

export class Store {
  constructor(readonly db: Database) {}

  insert(table: TableName, row: object): void {
    const entries = Object.entries(row);
    checkColumns(table, entries.map(([k]) => k));
    const keys = entries.map(([k]) => k);
    this.db.run(
      `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
      entries.map(([, v]) => enc(v) as SqlParam),
    );
  }

  update(table: TableName, id: string, patch: object): void {
    const entries = Object.entries(patch);
    checkColumns(table, entries.map(([k]) => k));
    const keys = entries.map(([k]) => k);
    if (keys.length === 0) return;
    this.db.run(
      `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`,
      [...entries.map(([, v]) => enc(v) as SqlParam), id],
    );
  }

  remove(table: TableName, id: string): boolean {
    return this.db.run(`DELETE FROM ${table} WHERE id = ?`, [id]).changes > 0;
  }

  removeWhere(table: TableName, clauses: readonly Clause[]): number {
    const where = clauses.length ? ` WHERE ${clauses.map((c) => c.sql).join(" AND ")}` : "";
    return this.db.run(`DELETE FROM ${table}${where}`, clauses.flatMap((c) => c.params)).changes;
  }

  byId<T>(table: TableName, id: string): T | null {
    const row = this.db.query(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    return row ? this.decode<T>(table, row as Record<string, unknown>) : null;
  }

  list<T>(
    table: TableName,
    clauses: readonly Clause[] = [],
    opts: { order?: string; limit?: number; offset?: number } = {},
  ): T[] {
    const where = clauses.length ? ` WHERE ${clauses.map((c) => c.sql).join(" AND ")}` : "";
    const order = opts.order ?? (table === "history_events" || table === "triage_events" ? "at, id" : "created_at, id");
    const limit = opts.limit ?? -1;
    const offset = opts.offset ?? 0;
    const rows = this.db
      .query(`SELECT * FROM ${table}${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...clauses.flatMap((c) => c.params), limit, offset) as Array<Record<string, unknown>>;
    return rows.map((r) => this.decode<T>(table, r));
  }

  count(table: TableName, clauses: readonly Clause[] = []): number {
    const where = clauses.length ? ` WHERE ${clauses.map((c) => c.sql).join(" AND ")}` : "";
    const row = this.db
      .query(`SELECT COUNT(*) AS n FROM ${table}${where}`)
      .get(...clauses.flatMap((c) => c.params)) as { n: number };
    return row.n;
  }

  private decode<T>(table: TableName, row: Record<string, unknown>): T {
    for (const f of TABLES[table].json) {
      const v = row[f];
      if (typeof v === "string") row[f] = JSON.parse(v);
    }
    return row as T;
  }

  getSettings(): Settings {
    const row = this.db.query("SELECT data FROM settings WHERE id = 1").get() as
      | { data: string }
      | null;
    return row ? { ...defaultSettings(), ...(JSON.parse(row.data) as Partial<Settings>) } : defaultSettings();
  }

  saveSettings(settings: Settings): void {
    this.db.run(
      "INSERT INTO settings (id, data) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data",
      [JSON.stringify(settings)],
    );
  }

  addHistory(evt: Omit<HistoryEvent, "id">): HistoryEvent {
    const full: HistoryEvent = { ...evt, id: crypto.randomUUID() };
    this.insert("history_events", full);
    return full;
  }

  findEvaluation(date: string, condition: string): EvaluationEntry | null {
    const rows = this.list<EvaluationEntry>("evaluations", [eq("date", date), eq("condition", condition)]);
    return rows[0] ?? null;
  }

  upsertEvaluation(input: EvaluationEntry, nowIso: string): EvaluationEntry {
    const existing = this.findEvaluation(input.date, input.condition);
    if (existing) {
      const { id: _id, created_at: _created, ...mutable } = input;
      const updated: EvaluationEntry = {
        ...input,
        id: existing.id,
        created_at: existing.created_at,
        updated_at: nowIso,
      };
      this.update("evaluations", existing.id, { ...mutable, updated_at: nowIso });
      return updated;
    }
    this.insert("evaluations", input);
    return input;
  }

  /** Every content-bearing entry/preparation/etc. for export and tests. */
  dump<T>(table: TableName): T[] {
    return this.list<T>(table, [], { limit: -1 });
  }

  entriesAll(): Entry[] {
    return this.dump<Entry>("entries");
  }
  preparationsAll(): Preparation[] {
    return this.dump<Preparation>("preparations");
  }
}
