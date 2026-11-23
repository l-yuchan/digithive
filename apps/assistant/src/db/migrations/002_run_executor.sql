ALTER TABLE runs ADD COLUMN executor_kind TEXT NOT NULL DEFAULT 'pending'
  CHECK (executor_kind IN ('pending','sha256','script','agent'));

ALTER TABLE runs ADD COLUMN request_key TEXT;
CREATE UNIQUE INDEX one_run_per_request ON runs(request_key) WHERE request_key IS NOT NULL;
