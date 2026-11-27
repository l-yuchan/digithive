import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../src/store/db";
import { OLDEST_OPENABLE } from "../src/store/db";
import { LATEST } from "../src/store/migrations";

/**
 * A database as the v10 build left it, carrying the entry form that build's v12 step
 * produced (the response events a v10 entry held, written back in place). Built by
 * taking a fresh schema back to v10, which is the only shape in the wild.
 */
function v10Database(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  migrate(db);
  db.transaction(() => {
    // A v10 database has neither the queue table nor the two conversation columns: they
    // arrived in v11..v13. Removing them is what makes this fixture a real v10 instead of
    // a copy of the current schema wearing an older version number.
    db.exec("DROP TABLE IF EXISTS session_queue");
    // The provider tables arrived in v17; a v10 database has none of them.
    for (const table of [
      "provider_state",
      "model_chain",
      "provider_models",
      "provider_connections",
    ])
      db.exec(`DROP TABLE IF EXISTS ${table}`);
    db.exec("ALTER TABLE sessions DROP COLUMN title_source");
    db.exec("ALTER TABLE sessions DROP COLUMN queue_paused");
    db.query(
      "INSERT INTO sessions(id,title,created_at,updated_at) VALUES ('s','kept','now','now')",
    ).run();
    // The entry form the v10 build's v12 step stored: its response events, written in
    // place. That step is retired, so a v10 database opened today already holds it.
    db.query(
      "INSERT INTO entries(id,session_id,kind,role,payload_json,created_at,seq) VALUES ('e','s','message','user',?,'now',1)",
    ).run(
      JSON.stringify({
        events: [
          { type: "thinking", id: 0, text: "생각" },
          { type: "tool_call", id: 1, callId: "c1", name: "gmail_search", detail: "{}" },
          {
            type: "tool_result",
            id: 2,
            callId: "c1",
            name: "gmail_search",
            detail: "ok",
            failed: true,
            denied: true,
          },
        ],
      }),
    );
    db.exec(`PRAGMA user_version = ${OLDEST_OPENABLE}`);
  })();
  return db;
}

function shape(db: Database): string[] {
  return (
    db
      .query<{ type: string; name: string; sql: string | null }, []>(
        "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts_%' ORDER BY type,name",
      )
      .all()
      // Whitespace is normalized before comparing: an `ALTER TABLE … ADD COLUMN` leaves a
      // trailing space before the closing parenthesis that the reset's own statement does
      // not, and spacing is not what this test is about.
      .map(
        (row) =>
          `${row.type}:${row.name}:${(row.sql ?? "").replace(/\s+/g, " ").replace(/\s+\)/g, ")")}`,
      )
  );
}

test("a legacy database upgrades to exactly the schema a fresh database starts with", () => {
  const legacy = v10Database();
  expect(legacy.query<{ user_version: number }, []>("PRAGMA user_version").get()).toEqual({
    user_version: OLDEST_OPENABLE,
  });
  migrate(legacy);
  const upgraded = shape(legacy);
  const fresh = new Database(":memory:");
  migrate(fresh);
  expect(upgraded).toEqual(shape(fresh));
  // The pieces a v10 database lacks are present, not merely versioned: an upgrade that
  // stamps the version without adding them leaves a database that fails on first use.
  expect(legacy.query("SELECT name FROM sqlite_master WHERE name='session_queue'").get()).toEqual({
    name: "session_queue",
  });
  expect(
    legacy
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('sessions')")
      .all()
      .map((column) => column.name)
      .filter((name) => name === "title_source" || name === "queue_paused"),
  ).toEqual(["title_source", "queue_paused"]);
  expect(legacy.query<{ user_version: number }, []>("PRAGMA user_version").get()).toEqual({
    user_version: LATEST,
  });
  legacy.close();
  fresh.close();
});

test("lifting one v10 entry keeps every event it described", () => {
  const db = v10Database();
  migrate(db);
  const row = db
    .query<{ payload_json: string }, []>("SELECT payload_json FROM entries WHERE id='e'")
    .get();
  expect(JSON.parse(row?.payload_json ?? "{}")).toEqual({
    events: [
      { type: "thinking", id: 0, text: "생각" },
      { type: "tool_call", id: 1, callId: "c1", name: "gmail_search", detail: "{}" },
      {
        type: "tool_result",
        id: 2,
        callId: "c1",
        name: "gmail_search",
        detail: "ok",
        failed: true,
        denied: true,
      },
    ],
  });
  db.close();
});
