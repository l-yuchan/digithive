import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../src/store/db";
import { getWorkflow } from "../src/workflows/workflow-store";
import {
  BRIEFING_WORKFLOW_ID,
  DAILY_SEARCH_TRIGGER,
  DAILY_SEARCH_WORKFLOW_ID,
} from "../src/workflows/system-workflows";

function binding(db: Database, id: string) {
  return db
    .query<{ workflow_id: string; trigger_json: string; next_run_at: string | null }, [string]>(
      "SELECT workflow_id,trigger_json,next_run_at FROM schedules WHERE id=?",
    )
    .get(id);
}

test("fresh databases contain both system agents and their daily bindings", () => {
  // Given an empty database opened through the real migration chain.
  const db = new Database(":memory:");
  try {
    // When all current migrations run.
    migrate(db);
    // Then each agent and its automatic trigger exists, not merely its instructions.
    expect(getWorkflow(db, BRIEFING_WORKFLOW_ID)?.executor).toEqual({ kind: "agent" });
    expect(getWorkflow(db, DAILY_SEARCH_WORKFLOW_ID)?.executor).toEqual({ kind: "agent" });
    expect(binding(db, "system:daily-search:06:30")).toMatchObject({
      workflow_id: DAILY_SEARCH_WORKFLOW_ID,
      trigger_json: JSON.stringify(DAILY_SEARCH_TRIGGER),
    });
    expect(binding(db, "system:briefing:07:30")?.workflow_id).toBe(BRIEFING_WORKFLOW_ID);
    expect(binding(db, "system:briefing:21:00")?.workflow_id).toBe(BRIEFING_WORKFLOW_ID);
  } finally {
    db.close();
  }
});

test("V16 moves a shipped briefing's existing schedule to the canonical agent", () => {
  // Given a v15 database with an already scheduled script briefing at a customized time.
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  try {
    migrate(db);
    db.transaction(() => {
      for (const id of ["system:briefing:07:30", "system:briefing:21:00"]) {
        db.query("DELETE FROM schedules WHERE id=?").run(id);
      }
      db.query("DELETE FROM workflows WHERE id=?").run(BRIEFING_WORKFLOW_ID);
      db.query("DELETE FROM workflows_fts WHERE workflow_id=?").run(BRIEFING_WORKFLOW_ID);
      db.query(
        `INSERT INTO workflows (id,title,instruction,executor_json,params_json,timeout_seconds,created_at,updated_at)
         VALUES ('legacy-briefing','Briefing','old',?,'[]',1800,'before','before')`,
      ).run(
        JSON.stringify({
          kind: "script",
          path: "@builtin/briefing.ts",
          args: [],
          capabilities: ["account.read", "mail.send"],
        }),
      );
      db.query("DROP TABLE IF EXISTS whiteboard_fts").run();
      db.query("DROP TABLE IF EXISTS whiteboard_documents").run();
      // The provider tables arrived in v17; a v15 database does not have them either.
      for (const table of [
        "provider_state",
        "model_chain",
        "provider_models",
        "provider_connections",
      ])
        db.query(`DROP TABLE IF EXISTS ${table}`).run();
      db.exec("PRAGMA user_version = 15");
      db.query(
        `INSERT INTO schedules (id,enabled,trigger_json,next_run_at,created_at,updated_at,workflow_id,args_json)
         VALUES ('owner-chosen-slot',1,?,'2030-01-01T00:00:00.000Z','before','before','legacy-briefing','{}')`,
      ).run(JSON.stringify({ kind: "daily", time: "08:15", timeZone: "Asia/Seoul" }));
    })();

    // When V16 migrates that stored definition.
    migrate(db);

    // Then the old schedule id and trigger survive on the canonical agent definition.
    const preserved = binding(db, "owner-chosen-slot");
    expect(preserved).toEqual({
      workflow_id: BRIEFING_WORKFLOW_ID,
      trigger_json: JSON.stringify({ kind: "daily", time: "08:15", timeZone: "Asia/Seoul" }),
      next_run_at: "2030-01-01T00:00:00.000Z",
    });
    expect(getWorkflow(db, "legacy-briefing")).toBeNull();
    expect(getWorkflow(db, BRIEFING_WORKFLOW_ID)?.executor).toEqual({ kind: "agent" });
  } finally {
    db.close();
  }
});
