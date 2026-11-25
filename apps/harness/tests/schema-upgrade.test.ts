import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../src/store/db";
import { OLDEST_OPENABLE } from "../src/store/db";

/**
 * A database as the v10 build left it. Built by taking a fresh schema back to v10
 * with a pre-event entry, which is the only shape in the wild (the live server).
 */
function v10Database(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  migrate(db);
  db.transaction(() => {
    db.query(
      "INSERT INTO sessions(id,title,created_at,updated_at) VALUES ('s','kept','now','now')",
    ).run();
    db.query(
      "INSERT INTO entries(id,session_id,kind,role,payload_json,created_at,seq) VALUES ('e','s','message','user',?,'now',1)",
    ).run(
      JSON.stringify({
        parts: [
          { type: "reasoning", text: "생각" },
          { type: "tool_call", id: "c1", name: "gmail_search", arguments: "{}" },
          {
            type: "tool_result",
            id: "c1",
            name: "gmail_search",
            output: "ok",
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
  return db
    .query<{ type: string; name: string; sql: string | null }, []>(
      "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts_%' ORDER BY type,name",
    )
    .all()
    .map((row) => `${row.type}:${row.name}:${(row.sql ?? "").replace(/\s+/g, " ")}`);
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
  expect(legacy.query<{ user_version: number }, []>("PRAGMA user_version").get()).toEqual({
    user_version: 13,
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
