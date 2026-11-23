ALTER TABLE candidates ADD COLUMN dedupe_key TEXT;
ALTER TABLE candidates ADD COLUMN confidence TEXT NOT NULL DEFAULT 'proposed';
ALTER TABLE candidates ADD COLUMN previous_json TEXT;
ALTER TABLE candidates ADD COLUMN retracted_at TEXT;

CREATE UNIQUE INDEX candidates_dedupe ON candidates(dedupe_key) WHERE dedupe_key IS NOT NULL;
