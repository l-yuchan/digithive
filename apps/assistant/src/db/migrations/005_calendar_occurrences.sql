CREATE TABLE calendar_occurrences (
  id TEXT PRIMARY KEY,
  source_item_id TEXT NOT NULL REFERENCES source_items(id),
  series_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  location TEXT,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  all_day INTEGER NOT NULL CHECK (all_day IN (0,1)),
  local_date TEXT,
  timezone TEXT,
  cancelled INTEGER NOT NULL DEFAULT 0 CHECK (cancelled IN (0,1)),
  overridden INTEGER NOT NULL DEFAULT 0 CHECK (overridden IN (0,1)),
  refreshed_at TEXT NOT NULL
);

CREATE INDEX calendar_occurrences_window ON calendar_occurrences(starts_at, ends_at);
