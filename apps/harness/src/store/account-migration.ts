/** v5's singleton Google credentials and source cursors become explicit accounts. */
export const ACCOUNT_MIGRATION = `
CREATE TABLE integration_accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('google','canvas')),
  subject TEXT,
  email TEXT,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider,subject)
);
INSERT INTO integration_accounts
  (id,provider,label,created_at,updated_at) VALUES
  ('google-default','google','기존 Google',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('canvas-default','canvas','한양 LMS',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));

CREATE TABLE account_sources (
  account_id TEXT NOT NULL REFERENCES integration_accounts(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK(source IN ('calendar','gmail','canvas')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  cursor TEXT,
  last_sync_at TEXT,
  last_attempt_at TEXT,
  ok INTEGER NOT NULL DEFAULT 0 CHECK(ok IN (0,1)),
  error TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(account_id,source)
);
CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  account_id TEXT REFERENCES integration_accounts(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO account_sources(account_id,source,cursor,last_sync_at,last_attempt_at,ok,error,detail_json)
SELECT CASE WHEN source='canvas' THEN 'canvas-default' ELSE 'google-default' END,
       source,cursor,last_sync_at,last_sync_at,ok,error,detail_json
FROM integration_state;
INSERT OR IGNORE INTO account_sources(account_id,source) VALUES
  ('google-default','calendar'),('google-default','gmail'),('canvas-default','canvas');
DROP TABLE integration_state;

ALTER TABLE oauth_tokens RENAME TO singleton_oauth_tokens;
CREATE TABLE oauth_tokens (
  account_id TEXT PRIMARY KEY REFERENCES integration_accounts(id) ON DELETE CASCADE,
  payload TEXT NOT NULL,
  scope TEXT,
  expires_at TEXT,
  updated_at TEXT NOT NULL
);
INSERT INTO oauth_tokens(account_id,payload,scope,expires_at,updated_at)
SELECT 'google-default',payload,scope,expires_at,updated_at
FROM singleton_oauth_tokens WHERE provider='google';
DROP TABLE singleton_oauth_tokens;

ALTER TABLE sync_items RENAME TO singleton_sync_items;
DROP INDEX sync_items_at;
CREATE TABLE sync_items (
  account_id TEXT NOT NULL,
  source TEXT NOT NULL,
  item_id TEXT NOT NULL,
  title TEXT NOT NULL,
  at TEXT,
  detail TEXT,
  url TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(account_id,source,item_id),
  FOREIGN KEY(account_id,source) REFERENCES account_sources(account_id,source) ON DELETE CASCADE
);
INSERT INTO sync_items(account_id,source,item_id,title,at,detail,url,updated_at)
SELECT CASE WHEN source='canvas' THEN 'canvas-default' ELSE 'google-default' END,
       source,item_id,title,at,detail,url,updated_at FROM singleton_sync_items;
DROP TABLE singleton_sync_items;
CREATE INDEX sync_items_at ON sync_items(source,at);
`;
