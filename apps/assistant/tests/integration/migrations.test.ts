import assert from "node:assert/strict";
import { afterEach, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { migrate, migrations, openDatabase, schemaVersion } from "../../src/db/store";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function database(): Database {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  databases.push(db);
  migrate(db, migrations());
  return db;
}

test("keeps the previous row and schema version when a later migration fails", () => {
  const db = database();
  db.query("INSERT INTO settings (key,value_json,updated_by,updated_at) VALUES (?,?,?,?)")
    .run("keep", '"before"', "qa", new Date(0).toISOString());

  assert.throws(() => migrate(db, [{
    version: 2,
    sql: "UPDATE settings SET value_json='\"after\"' WHERE key='keep'; INSERT INTO missing_table VALUES (1);",
  }]));

  assert.deepEqual(db.query("SELECT value_json FROM settings WHERE key='keep'").get(), {
    value_json: '"before"',
  });
  assert.equal(schemaVersion(db), 1);
});

test("rejects source records without a referenced connection", () => {
  const db = database();
  db.query("INSERT INTO connections (id,provider,scopes_json) VALUES ('c1','google','[]')").run();
  db.query("INSERT INTO source_items (id,connection_id,remote_id,observed_at) VALUES (?,?,?,?)")
    .run("i1", "c1", "r1", new Date(0).toISOString());

  assert.throws(() => db.query("INSERT INTO source_items (id,connection_id,remote_id,observed_at) VALUES (?,?,?,?)")
    .run("i3", "missing", "r2", new Date(0).toISOString()));
});

test("rejects the same source identity from a second database connection", () => {
  const directory = mkdtempSync(join(tmpdir(), "digithive-concurrent-"));
  const filename = join(directory, "shared.sqlite");
  const first = openDatabase(filename);
  const second = openDatabase(filename);
  try {
    first.query("INSERT INTO connections (id,provider,scopes_json) VALUES ('c1','google','[]')").run();
    first.query("INSERT INTO source_items (id,connection_id,remote_id,observed_at) VALUES (?,?,?,?)")
      .run("i1", "c1", "same", new Date(0).toISOString());

    assert.throws(() => second.query("INSERT INTO source_items (id,connection_id,remote_id,observed_at) VALUES (?,?,?,?)")
      .run("i2", "c1", "same", new Date(0).toISOString()));
    const count = z.object({ total: z.number() }).parse(first.query("SELECT count(*) AS total FROM source_items").get());
    assert.equal(count.total, 1);
  } finally {
    second.close();
    first.close();
    rmSync(directory, { recursive: true });
  }
});
