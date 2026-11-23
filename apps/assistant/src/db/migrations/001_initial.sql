CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  credential_ciphertext BLOB,
  sync_cursor TEXT,
  sync_status TEXT NOT NULL DEFAULT 'new',
  last_success_at TEXT
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id),
  automation_id TEXT REFERENCES automations(id),
  scheduled_slot TEXT,
  goal TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN
    ('queued','running','awaiting_approval','succeeded','failed','cancelled','interrupted')),
  revision INTEGER NOT NULL DEFAULT 1,
  next_fence INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (automation_id, scheduled_slot)
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  run_id TEXT REFERENCES runs(id),
  client_request_id TEXT UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE source_items (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections(id),
  remote_id TEXT NOT NULL,
  current_version_id TEXT REFERENCES source_versions(id),
  observed_at TEXT NOT NULL,
  UNIQUE (connection_id, remote_id)
);

CREATE TABLE source_versions (
  id TEXT PRIMARY KEY,
  source_item_id TEXT NOT NULL REFERENCES source_items(id),
  content_hash TEXT NOT NULL,
  content_json TEXT NOT NULL,
  tombstone INTEGER NOT NULL DEFAULT 0 CHECK (tombstone IN (0,1)),
  observed_at TEXT NOT NULL,
  effective_at TEXT,
  UNIQUE (source_item_id, content_hash)
);

CREATE TABLE sync_batches (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections(id),
  status TEXT NOT NULL,
  next_cursor TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  statement TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('fact','preference','inference','interest','commitment')),
  status TEXT NOT NULL CHECK (status IN ('active','superseded','deleted')),
  evidence_ref TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  context_epoch INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE memory_edges (
  from_id TEXT NOT NULL REFERENCES memories(id),
  to_id TEXT NOT NULL REFERENCES memories(id),
  relation TEXT NOT NULL CHECK (relation IN ('supersedes','derived_from')),
  PRIMARY KEY (from_id, to_id, relation)
);

CREATE TABLE context_threads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE commitments (
  id TEXT PRIMARY KEY,
  source_version_id TEXT REFERENCES source_versions(id),
  description TEXT NOT NULL,
  due_at TEXT,
  timezone TEXT,
  status TEXT NOT NULL,
  confirmed_by TEXT
);

CREATE TABLE candidates (
  id TEXT PRIMARY KEY,
  source_version_id TEXT NOT NULL REFERENCES source_versions(id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  proposed_at TEXT,
  timezone TEXT,
  evidence_json TEXT NOT NULL
);

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  logical_path TEXT NOT NULL UNIQUE,
  owner_run_id TEXT REFERENCES runs(id),
  sha256 TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  blob_ref TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE file_derivations (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  derived_blob_ref TEXT,
  error_code TEXT
);

CREATE TABLE automations (
  id TEXT PRIMARY KEY,
  definition_version INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  definition_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  number INTEGER NOT NULL,
  fence INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','claimed','running','succeeded','failed','cancelled','interrupted')),
  worker_id TEXT,
  lease_until TEXT,
  heartbeat_at TEXT,
  UNIQUE (run_id, number),
  UNIQUE (run_id, fence)
);

CREATE TABLE run_events (
  run_id TEXT NOT NULL REFERENCES runs(id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  action_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned','consumed','succeeded','failed','outcome_unknown')),
  args_json TEXT NOT NULL
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES runs(id),
  action_hash TEXT NOT NULL,
  scope TEXT NOT NULL,
  version_ref TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_by TEXT,
  decision TEXT,
  consumed_at TEXT
);

CREATE TABLE cost_reservations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  provider_request_id TEXT NOT NULL UNIQUE,
  month_bucket TEXT NOT NULL,
  price_version TEXT NOT NULL,
  reserved_micro_usd INTEGER NOT NULL CHECK (reserved_micro_usd >= 0),
  settled_micro_usd INTEGER,
  status TEXT NOT NULL CHECK (status IN ('active','settled','unknown')),
  created_at TEXT NOT NULL
);

CREATE TABLE usage_ledger (
  id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL UNIQUE REFERENCES cost_reservations(id),
  billed_micro_usd INTEGER,
  observed_at TEXT NOT NULL
);

CREATE TABLE briefings (
  id TEXT PRIMARY KEY,
  slot TEXT NOT NULL,
  config_revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (slot, config_revision)
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  notification_key TEXT NOT NULL UNIQUE,
  briefing_id TEXT REFERENCES briefings(id),
  kind TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint_ciphertext BLOB NOT NULL,
  key_ciphertext BLOB NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL REFERENCES notifications(id),
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id),
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','failed','expired','opened')),
  next_attempt_at TEXT,
  UNIQUE (notification_id, subscription_id)
);

CREATE TABLE change_proposals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','tested','awaiting_approval','approved','applying','applied','failed','rolled_back')),
  artifact_digest TEXT NOT NULL,
  diff_ref TEXT NOT NULL,
  test_evidence_ref TEXT,
  approval_id TEXT REFERENCES approvals(id)
);

CREATE TABLE tool_versions (
  id TEXT PRIMARY KEY,
  tool_id TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),
  approved_by TEXT NOT NULL,
  UNIQUE (tool_id, artifact_digest)
);

CREATE UNIQUE INDEX one_active_tool_version ON tool_versions(tool_id) WHERE active = 1;

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
