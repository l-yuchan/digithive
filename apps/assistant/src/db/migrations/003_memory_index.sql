CREATE VIRTUAL TABLE memory_index USING fts5(
  memory_id UNINDEXED,
  statement,
  tokenize = 'unicode61'
);

INSERT INTO settings (key, value_json, revision, updated_by, updated_at)
VALUES ('context_epoch', '1', 1, 'system', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(key) DO NOTHING;
