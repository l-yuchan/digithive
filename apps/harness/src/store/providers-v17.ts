import type { Database } from "bun:sqlite";
import type { Transition } from "./migrations";

/**
 * V17 — model providers as rows, not environment variables.
 *
 * Definitions are kept apart from what they produce and from what runs:
 *
 * - `provider_connections` is a provider the owner added: which catalog it follows, its
 *   base URL, its key (sealed with the deployment secret, never stored in the clear) and
 *   its custom headers. A custom provider is one of these too; the catalog says which
 *   extra reads it supports.
 * - `provider_models` is what the provider served when it was last read: the offer list
 *   the picker shows, with the context and price the provider stated.
 * - `model_chain` is the routing list: which model on which provider is tried, in order.
 *   It is the only place the router looks, so a model is used because it is in the chain,
 *   not because it happens to have been listed.
 * - `provider_state` is the last probe outcome (models / usage, each with its own error),
 *   so the screen can show the previous reading before the next probe.
 */
export const V17_MODEL_PROVIDERS_SQL = `
CREATE TABLE provider_connections (
  id TEXT PRIMARY KEY,
  catalog_id TEXT NOT NULL,
  label TEXT NOT NULL,
  base_url TEXT NOT NULL,
  key_sealed TEXT NOT NULL,
  headers_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(headers_json)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE provider_models (
  provider_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'chat',
  context_length INTEGER,
  max_output INTEGER,
  input_price REAL,
  output_price REAL,
  tags_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags_json)),
  PRIMARY KEY(provider_id, model_id)
);

CREATE TABLE model_chain (
  position INTEGER PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  created_at TEXT NOT NULL,
  UNIQUE(provider_id, model_id)
);

CREATE TABLE provider_state (
  provider_id TEXT PRIMARY KEY REFERENCES provider_connections(id) ON DELETE CASCADE,
  models_fetched_at TEXT,
  models_error TEXT,
  usage_json TEXT CHECK(usage_json IS NULL OR json_valid(usage_json)),
  usage_fetched_at TEXT,
  usage_error TEXT,
  checked_at TEXT
);
`;

export const V17: Transition = {
  version: 17,
  sql: V17_MODEL_PROVIDERS_SQL,
  run: (db) => {
    // A database older than the reset reaches this step without the queue table and the two
    // conversation columns, because the step that used to add them (V15) is no longer kept.
    // V16 reads schedules only, so this step is where an older database is repaired for
    // everything the kept chain no longer carries; running it again is harmless.
    restoreConversationSchema(db);
  },
};

/**
 * The queue table and the two conversation columns a database older than the kept chain
 * lacks. Declared here rather than in migrations.ts so the kept steps can use it without
 * a cycle.
 */
export function restoreConversationSchema(db: Database): void {
  const columns = db
    .query<{ name: string }, []>("SELECT name FROM pragma_table_info('sessions')")
    .all()
    .map((column) => column.name);
  if (!columns.includes("title_source"))
    db.run("ALTER TABLE sessions ADD COLUMN title_source TEXT NOT NULL DEFAULT 'initial'");
  if (!columns.includes("queue_paused"))
    db.run("ALTER TABLE sessions ADD COLUMN queue_paused INTEGER NOT NULL DEFAULT 0");
  db.run(`CREATE TABLE IF NOT EXISTS session_queue (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);
}

/** True once the provider tables exist (a database at v17 or later). */
export function hasProviderTables(db: Database): boolean {
  const row = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='provider_connections'",
    )
    .get();
  return row !== undefined;
}
