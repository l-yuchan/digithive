/**
 * v10 separates a reusable definition from its automatic execution.
 *
 * `workflows` owns what runs; `schedules` becomes a trigger binding that names one
 * workflow and carries the parameter values the automation uses. Existing rows are
 * moved with a deterministic id (`wf-<schedule id>`) so the migration is re-runnable
 * by inspection rather than by guessing.
 *
 * The binding table is extended in place instead of being rebuilt: `schedule_occurrences`
 * references it with a foreign key, and a migration runs inside a transaction where
 * `PRAGMA foreign_keys` cannot be switched off, so dropping the parent table would
 * silently null the history via the implicit delete.
 */
export const WORKFLOW_MIGRATION = `
CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  instruction TEXT NOT NULL,
  executor_json TEXT NOT NULL CHECK(json_valid(executor_json)),
  params_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(params_json)),
  timeout_seconds INTEGER NOT NULL DEFAULT 1800 CHECK(timeout_seconds BETWEEN 1 AND 86400),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX workflows_updated ON workflows(updated_at);
CREATE VIRTUAL TABLE workflows_fts USING fts5(workflow_id UNINDEXED, text, tokenize = 'trigram');

INSERT INTO workflows (id,title,instruction,executor_json,params_json,timeout_seconds,created_at,updated_at)
SELECT 'wf-'||id, title, instruction, executor_json, '[]', timeout_seconds, created_at, updated_at
  FROM schedules;
INSERT INTO workflows_fts (workflow_id, text) SELECT id, title||' '||instruction FROM workflows;

ALTER TABLE schedules ADD COLUMN workflow_id TEXT REFERENCES workflows(id) ON DELETE RESTRICT;
ALTER TABLE schedules ADD COLUMN args_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(args_json));
UPDATE schedules SET workflow_id = 'wf-'||id;
ALTER TABLE schedules DROP COLUMN title;
ALTER TABLE schedules DROP COLUMN instruction;
ALTER TABLE schedules DROP COLUMN executor_json;
ALTER TABLE schedules DROP COLUMN timeout_seconds;
CREATE INDEX schedules_workflow ON schedules(workflow_id);
CREATE TRIGGER schedules_require_workflow_insert BEFORE INSERT ON schedules
WHEN NEW.workflow_id IS NULL BEGIN SELECT RAISE(ABORT,'schedule_workflow_required'); END;
CREATE TRIGGER schedules_require_workflow_update BEFORE UPDATE OF workflow_id ON schedules
WHEN NEW.workflow_id IS NULL BEGIN SELECT RAISE(ABORT,'schedule_workflow_required'); END;

ALTER TABLE runs ADD COLUMN workflow_id TEXT;
ALTER TABLE runs ADD COLUMN workflow_title TEXT;
ALTER TABLE runs ADD COLUMN schedule_id TEXT;
ALTER TABLE runs ADD COLUMN trigger_kind TEXT CHECK(trigger_kind IN ('schedule','manual','tool','script','delegation'));
ALTER TABLE runs ADD COLUMN params_json TEXT NOT NULL DEFAULT '{}';
CREATE INDEX runs_workflow ON runs(workflow_id, created_at);

UPDATE runs SET
  schedule_id = (SELECT o.schedule_id FROM schedule_occurrences o WHERE o.run_id = runs.id),
  trigger_kind = COALESCE(
    (SELECT CASE o.manual WHEN 1 THEN 'manual' ELSE 'schedule' END
       FROM schedule_occurrences o WHERE o.run_id = runs.id),
    CASE runs.origin WHEN 'delegation' THEN 'delegation' ELSE 'manual' END),
  workflow_id = (SELECT s.workflow_id FROM schedule_occurrences o JOIN schedules s ON s.id = o.schedule_id
                  WHERE o.run_id = runs.id),
  workflow_title = COALESCE(
    (SELECT w.title FROM schedule_occurrences o
       JOIN schedules s ON s.id = o.schedule_id
       JOIN workflows w ON w.id = s.workflow_id
      WHERE o.run_id = runs.id),
    (SELECT o.schedule_title FROM schedule_occurrences o WHERE o.run_id = runs.id));
`;
