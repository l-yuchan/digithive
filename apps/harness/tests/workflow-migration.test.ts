import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { MIGRATIONS } from "../src/store/migrations";
import { migrate } from "../src/store/db";

const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/** A database at the last schema before workflows existed, with lived-in rows. */
function v9Database() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  for (const migration of MIGRATIONS.filter((entry) => entry.version <= 9)) {
    db.transaction(() => db.exec(migration.sql))();
  }
  db.exec("PRAGMA user_version=9");
  db.query(
    `INSERT INTO schedules (id,title,instruction,enabled,trigger_json,executor_json,timeout_seconds,next_run_at,created_at,updated_at)
     VALUES ('mine','내 작업','요약한다',1,
             '{"kind":"interval","everySeconds":3600,"anchorAt":"2026-01-01T00:00:00.000Z"}',
             '{"kind":"agent"}',900,'2026-01-01T00:30:00.000Z',
             '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
  ).run();
  db.query(
    `INSERT INTO runs (id,origin,goal,status,budget_json,executor_json,timeout_seconds,created_at)
     VALUES ('run-1','work','요약한다','succeeded','{}','{"kind":"agent"}',900,'2026-01-01T00:00:00.000Z')`,
  ).run();
  db.query(
    `INSERT INTO schedule_occurrences (id,schedule_id,schedule_title,scheduled_for,run_id,manual,created_at)
     VALUES ('occ-1','mine','내 작업','2026-01-01T00:00:00.000Z','run-1',0,'2026-01-01T00:00:00.000Z')`,
  ).run();
  return db;
}

test("v10 moves definitions into workflows and leaves bindings and history intact", () => {
  const db = v9Database();
  const schedulesBefore =
    db.query<{ n: number }, []>("SELECT count(*) AS n FROM schedules").get()?.n ?? 0;

  expect(migrate(db)).toBe(1);
  expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()).toEqual({
    user_version: 10,
  });

  const workflow = db
    .query<
      {
        id: string;
        title: string;
        executor_json: string;
        params_json: string;
        timeout_seconds: number;
      },
      []
    >("SELECT id,title,executor_json,params_json,timeout_seconds FROM workflows WHERE id='wf-mine'")
    .get();
  expect(workflow).toEqual({
    id: "wf-mine",
    title: "내 작업",
    executor_json: '{"kind":"agent"}',
    params_json: "[]",
    timeout_seconds: 900,
  });

  const schedulesAfter =
    db.query<{ n: number }, []>("SELECT count(*) AS n FROM schedules").get()?.n ?? 0;
  expect(schedulesAfter).toBe(schedulesBefore);

  const binding = db
    .query<
      { id: string; workflow_id: string; enabled: number; args_json: string; next_run_at: string },
      []
    >("SELECT id,workflow_id,enabled,args_json,next_run_at FROM schedules WHERE id='mine'")
    .get();
  expect(binding).toEqual({
    id: "mine",
    workflow_id: "wf-mine",
    enabled: 1,
    args_json: "{}",
    next_run_at: "2026-01-01T00:30:00.000Z",
  });

  // The old definition columns are gone; a second boot must not try to readd them.
  const columns = db
    .query<{ name: string }, []>("SELECT name FROM pragma_table_info('schedules')")
    .all()
    .map((row) => row.name);
  expect(columns).not.toContain("executor_json");
  expect(columns).not.toContain("title");
  expect(migrate(db)).toBe(0);
});

test("v10 records what the existing run executed and why", () => {
  const db = v9Database();
  migrate(db);
  const run = db
    .query<
      {
        workflow_id: string;
        workflow_title: string;
        schedule_id: string;
        trigger_kind: string;
        params_json: string;
      },
      []
    >(
      "SELECT workflow_id,workflow_title,schedule_id,trigger_kind,params_json FROM runs WHERE id='run-1'",
    )
    .get();
  expect(run).toEqual({
    workflow_id: "wf-mine",
    workflow_title: "내 작업",
    schedule_id: "mine",
    trigger_kind: "schedule",
    params_json: "{}",
  });
  expect(
    db
      .query<{ schedule_id: string }, []>(
        "SELECT schedule_id FROM schedule_occurrences WHERE id='occ-1'",
      )
      .get(),
  ).toEqual({ schedule_id: "mine" });
});

test("v10 makes the search index and the binding guards work", () => {
  const db = v9Database();
  migrate(db);
  expect(
    db
      .query<{ workflow_id: string }, []>(
        "SELECT workflow_id FROM workflows_fts WHERE workflows_fts MATCH '요약한다'",
      )
      .all(),
  ).toEqual([{ workflow_id: "wf-mine" }]);

  expect(() =>
    db
      .query(
        `INSERT INTO schedules (id,workflow_id,trigger_json,enabled,args_json,next_run_at,created_at,updated_at)
         VALUES ('orphan',NULL,'{"kind":"once","at":"2026-01-01T00:00:00.000Z"}',1,'{}',NULL,'a','a')`,
      )
      .run(),
  ).toThrow("schedule_workflow_required");

  expect(() => db.query("DELETE FROM workflows WHERE id='wf-mine'").run()).toThrow();
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
