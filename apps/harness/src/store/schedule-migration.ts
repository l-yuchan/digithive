/** Occurrences link to runs; leases/status/approval/results have a single owner. */
export const SCHEDULE_MIGRATION = `
ALTER TABLE runs ADD COLUMN executor_json TEXT NOT NULL DEFAULT '{"kind":"agent"}';
ALTER TABLE runs ADD COLUMN timeout_seconds INTEGER NOT NULL DEFAULT 1800
  CHECK(timeout_seconds BETWEEN 1 AND 86400);
ALTER TABLE briefings ADD COLUMN run_id TEXT REFERENCES runs(id);
CREATE UNIQUE INDEX briefings_run ON briefings(run_id) WHERE run_id IS NOT NULL;
DROP INDEX briefings_slot_day;
CREATE UNIQUE INDEX briefings_slot_day ON briefings(slot,substr(created_at,1,10)) WHERE run_id IS NULL;

CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  instruction TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  trigger_json TEXT NOT NULL CHECK(json_valid(trigger_json)),
  executor_json TEXT NOT NULL CHECK(json_valid(executor_json)),
  timeout_seconds INTEGER NOT NULL DEFAULT 1800 CHECK(timeout_seconds BETWEEN 1 AND 86400),
  next_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX schedules_due ON schedules(enabled,next_run_at);

CREATE TABLE schedule_occurrences (
  id TEXT PRIMARY KEY,
  schedule_id TEXT REFERENCES schedules(id) ON DELETE SET NULL,
  schedule_title TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
  manual INTEGER NOT NULL DEFAULT 0 CHECK(manual IN (0,1)),
  created_at TEXT NOT NULL,
  UNIQUE(schedule_id,scheduled_for)
);
CREATE INDEX schedule_occurrences_schedule ON schedule_occurrences(schedule_id,created_at);

INSERT INTO schedules(id,title,instruction,trigger_json,executor_json,next_run_at,created_at,updated_at)
VALUES
('system-sync','연결 자료 수집','사용 중인 계정과 소스의 자료를 수집합니다.',
 json_object('kind','interval','everySeconds',900,'anchorAt',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 '{"kind":"builtin","name":"sync_sources"}',
 strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('system-briefing-morning','아침 브리핑','수집된 자료로 브리핑을 만들고 등록된 기기에 알립니다.',
 '{"kind":"daily","time":"07:30","timeZone":"Asia/Seoul"}',
 '{"kind":"builtin","name":"briefing"}',NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('system-briefing-evening','저녁 브리핑','수집된 자료로 브리핑을 만들고 등록된 기기에 알립니다.',
 '{"kind":"daily","time":"21:00","timeZone":"Asia/Seoul"}',
 '{"kind":"builtin","name":"briefing"}',NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
`;

/**
 * v8 stops the seeded collection schedule. Collection now names its account, so a
 * schedule that reads every account is not something to install; the definition
 * and its history stay, but it no longer runs.
 */
export const COLLECTION_SEED_RETIREMENT = `
UPDATE schedules
   SET enabled = 0, next_run_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE id = 'system-sync' AND json_extract(executor_json, '$.accountId') IS NULL;
`;
