import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Durable storage: one SQLite file, WAL mode, prepared statements via bun:sqlite.
// Migrations are recorded in schema_migrations and are idempotent (re-running
// openDatabase on an existing file is a no-op).

const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE entries (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL,
        original_text TEXT NOT NULL, status TEXT NOT NULL, provenance TEXT NOT NULL,
        context TEXT NOT NULL, source_ids TEXT NOT NULL, derived_from_entry_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL,
        scope TEXT NOT NULL);
      CREATE INDEX entries_kind ON entries(kind);
      CREATE INDEX entries_scope ON entries(scope);
      CREATE INDEX entries_derived ON entries(derived_from_entry_id);
      CREATE TABLE preferences (
        id TEXT PRIMARY KEY, key TEXT NOT NULL, scope TEXT NOT NULL, value TEXT NOT NULL,
        status TEXT NOT NULL, provenance TEXT NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, version INTEGER NOT NULL);
      CREATE TABLE sources (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, url TEXT, publisher TEXT,
        published_at TEXT, evidence_summary TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE developments (
        id TEXT PRIMARY KEY, source_id TEXT NOT NULL, occurred_at TEXT NOT NULL,
        summary TEXT NOT NULL, content TEXT, time_sensitivity TEXT NOT NULL,
        deadline TEXT, addresses_obstacle_entry_ids TEXT NOT NULL,
        created_at TEXT NOT NULL);
      CREATE INDEX developments_source ON developments(source_id);
      CREATE TABLE suggestions (
        id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, development_id TEXT NOT NULL,
        status TEXT NOT NULL, strength TEXT NOT NULL, score REAL NOT NULL,
        matcher TEXT NOT NULL, why_now TEXT NOT NULL, hold_until TEXT,
        surfaced_at TEXT, response TEXT, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, hold_reason TEXT);
      CREATE INDEX suggestions_entry ON suggestions(entry_id);
      CREATE INDEX suggestions_pair ON suggestions(entry_id, development_id);
      CREATE TABLE triage_events (
        id TEXT PRIMARY KEY, development_id TEXT NOT NULL, entry_id TEXT NOT NULL,
        outcome TEXT NOT NULL, reason TEXT NOT NULL, score REAL NOT NULL,
        at TEXT NOT NULL);
      CREATE INDEX triage_development ON triage_events(development_id);
      CREATE INDEX triage_entry ON triage_events(entry_id);
      CREATE TABLE preparations (
        id TEXT PRIMARY KEY, request TEXT NOT NULL, delegation_id TEXT,
        suggestion_id TEXT, scope TEXT NOT NULL, max_steps INTEGER NOT NULL,
        status TEXT NOT NULL, produced_actions TEXT NOT NULL, result_summary TEXT,
        model TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);
      CREATE TABLE history_events (
        id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
        action TEXT NOT NULL, actor TEXT NOT NULL, summary TEXT NOT NULL,
        details TEXT, at TEXT NOT NULL);
      CREATE INDEX history_entity ON history_events(entity_type, entity_id);
      CREATE TABLE evaluations (
        id TEXT PRIMARY KEY, date TEXT NOT NULL, condition TEXT NOT NULL,
        context_recovery_minutes REAL, search_minutes REAL, task_restart_minutes REAL,
        review_correction_minutes REAL, assistant_management_minutes REAL,
        interruption_recovery_minutes REAL, opportunities_offered INTEGER NOT NULL,
        opportunities_accepted INTEGER NOT NULL, missed_high_value INTEGER NOT NULL,
        unwanted_interruptions INTEGER NOT NULL, grounding_errors INTEGER NOT NULL,
        correction_events INTEGER NOT NULL, cancellation_violations INTEGER NOT NULL,
        approval_boundary_violations INTEGER NOT NULL, usefulness_rating INTEGER,
        burden_rating INTEGER, control_rating INTEGER, confidence_rating INTEGER,
        notes TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE (date, condition));
      CREATE TABLE backup_snapshots (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL, file_name TEXT NOT NULL,
        size_bytes INTEGER NOT NULL);
    `,
  },
  {
    // Subscribed iCal feeds and the occurrences expanded from them. Synced
    // rows are reference data: they never become entries on their own.
    version: 2,
    sql: `
      CREATE TABLE calendars (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, color TEXT NOT NULL,
        enabled INTEGER NOT NULL, last_synced_at TEXT, last_error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE calendar_events (
        id TEXT PRIMARY KEY, calendar_id TEXT NOT NULL, uid TEXT NOT NULL,
        summary TEXT NOT NULL, location TEXT, starts_at TEXT NOT NULL, ends_at TEXT,
        all_day INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL);
      CREATE INDEX calendar_events_calendar ON calendar_events(calendar_id);
      CREATE INDEX calendar_events_start ON calendar_events(starts_at);
      CREATE UNIQUE INDEX calendar_events_occurrence ON calendar_events(calendar_id, uid, starts_at);
    `,
  },
];

export function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

export function migrate(db: Database): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const rows = db.query("SELECT version FROM schema_migrations").all() as Array<{
    version: number;
  }>;
  const applied = new Set(rows.map((r) => r.version));
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const apply = db.transaction(() => {
      db.exec(m.sql);
      db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [
        m.version,
        new Date().toISOString(),
      ]);
    });
    apply();
  }
}
