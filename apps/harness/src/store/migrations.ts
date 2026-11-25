import { ACCOUNT_MIGRATION } from "./account-migration";
import { SCHEDULE_MIGRATION } from "./schedule-migration";

export type Migration = {
  readonly version: number;
  readonly sql: string;
};

/**
 * Schema from `.omo/plans/digithive-harness-rewrite.md` §3.
 * Never edit a shipped migration: add the next version instead.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  deleted_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  parent_id TEXT REFERENCES entries(id),
  kind TEXT NOT NULL,
  role TEXT,
  status TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  seq INTEGER NOT NULL
);
CREATE INDEX entries_tree ON entries(session_id, parent_id);
CREATE UNIQUE INDEX entries_seq ON entries(session_id, seq);

CREATE TABLE parts (
  entry_id TEXT NOT NULL REFERENCES entries(id),
  idx INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (entry_id, idx)
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id),
  parent_run_id TEXT REFERENCES runs(id),
  origin TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL,
  cancel_intent TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  budget_json TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL,
  settled_at TEXT
);
CREATE INDEX runs_live ON runs(status, lease_expires_at);

CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  entry_id TEXT REFERENCES entries(id),
  name TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  decision TEXT,
  decision_by TEXT,
  status TEXT NOT NULL,
  result_json TEXT,
  started_at TEXT,
  ended_at TEXT,
  deadline_at TEXT
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  tool_call_id TEXT NOT NULL REFERENCES tool_calls(id),
  status TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  note TEXT
);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  session_id TEXT,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX events_run ON events(run_id, seq);
CREATE INDEX events_session ON events(session_id, seq);

CREATE TABLE saved_approvals (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`,
  },
  {
    version: 2,
    sql: `
ALTER TABLE sessions ADD COLUMN leaf_id TEXT;

CREATE VIRTUAL TABLE entries_fts USING fts5(
  entry_id UNINDEXED,
  session_id UNINDEXED,
  text,
  tokenize = 'trigram'
);
`,
  },
  {
    version: 3,
    sql: `
ALTER TABLE runs ADD COLUMN state_json TEXT;
CREATE INDEX runs_origin ON runs(origin, status);
`,
  },
  {
    version: 4,
    sql: `
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  source_json TEXT NOT NULL DEFAULT '{}',
  superseded_by TEXT REFERENCES memories(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX memories_live ON memories(superseded_by);

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  path TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'upload',
  created_at TEXT NOT NULL
);
CREATE INDEX files_sha ON files(sha256);

CREATE TABLE integration_state (
  source TEXT PRIMARY KEY,
  cursor TEXT,
  last_sync_at TEXT,
  ok INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}'
);
`,
  },
  {
    version: 5,
    sql: `
CREATE TABLE oauth_tokens (
  provider TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  scope TEXT,
  expires_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_success_at TEXT,
  last_error TEXT,
  last_error_at TEXT
);

CREATE TABLE briefings (
  id TEXT PRIMARY KEY,
  slot TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX briefings_slot_day ON briefings(slot, substr(created_at, 1, 10));

CREATE TABLE sync_items (
  source TEXT NOT NULL,
  item_id TEXT NOT NULL,
  title TEXT NOT NULL,
  at TEXT,
  detail TEXT,
  url TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, item_id)
);
CREATE INDEX sync_items_at ON sync_items(at);
`,
  },
  { version: 6, sql: ACCOUNT_MIGRATION },
  { version: 7, sql: SCHEDULE_MIGRATION },
];
