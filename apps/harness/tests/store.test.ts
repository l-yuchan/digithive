import { describe, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDatabase, OLDEST_OPENABLE } from "../src/store/db";
import { LATEST, RESET_VERSION, V14 } from "../src/store/migrations";

function memoryDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

function version(db: Database): number {
  return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
}

describe("store migrations", () => {
  test("a fresh database is created at the latest schema version", () => {
    const db = memoryDb();
    const names = db
      .query<{ name: string }, SQLQueryBindings[]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    for (const table of [
      "approvals",
      "entries",
      "events",
      "runs",
      "saved_approvals",
      "sessions",
      "tool_calls",
      "workflows",
    ]) {
      expect(names).toContain(table);
    }
    // The v1 `parts` table is retired: an entry owns its payload.
    expect(names).not.toContain("parts");
    expect(version(db)).toBe(LATEST);
    expect(LATEST).toBeGreaterThan(RESET_VERSION);
  });

  test("re-running migrate applies nothing", () => {
    const db = memoryDb();
    expect(migrate(db)).toBe(0);
    expect(migrate(db)).toBe(0);
  });

  test("foreign keys reject an orphan entry", () => {
    const db = memoryDb();
    expect(() =>
      db
        .query(
          "INSERT INTO entries (id, session_id, kind, payload_json, created_at, seq) VALUES ('e1','missing','message','{}','now',1)",
        )
        .run(),
    ).toThrow("FOREIGN KEY");
  });

  test("openDatabase works on a file and is idempotent across connections", () => {
    const path = join(mkdtempSync(join(tmpdir(), "harness-open-")), "db.sqlite");
    try {
      const first = openDatabase(path);
      expect(version(first)).toBe(LATEST);
      first.close();
      const second = openDatabase(path);
      expect(migrate(second)).toBe(0);
      second.close();
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  test("a database older than the reset is refused instead of half-upgraded", () => {
    // WAL leaves -wal/-shm beside the file, so the whole set is removed.
    const path = join(mkdtempSync(join(tmpdir(), "harness-refuse-")), "old.db");
    const old = new Database(path, { create: true });
    old.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY)");
    old.exec(`PRAGMA user_version = ${OLDEST_OPENABLE - 1}`);
    old.close();
    try {
      // Refused at open, before anything writes to the file.
      expect(() => openDatabase(path)).toThrow("older than this build supports");
      const after = new Database(path, { readonly: true });
      expect(version(after)).toBe(OLDEST_OPENABLE - 1);
      after.close();
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });
});

describe("the kept schema steps", () => {
  /** A database the reset built, with one entry stored in the pre-event form. */
  function fresh(): Database {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
    return db;
  }

  test("a fresh database ends at the latest version and reports the steps it ran", () => {
    // The count reports the kept steps that ran; the reset is not a transition.
    const db = new Database(":memory:");
    expect(migrate(db)).toBe(3);
    // Each kept step ran on top of the reset, and v13's queue table is in the result.
    expect(version(db)).toBe(LATEST);
    expect(
      db.query("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='session_queue'").get(),
    ).toEqual({ n: 1 });
  });

  test("a database one version behind runs exactly the step it lacks", () => {
    const db = fresh();
    db.exec(`PRAGMA user_version = ${V14.version - 1}`);
    expect(migrate(db)).toBe(1);
    expect(version(db)).toBe(LATEST);
  });

  test("v14 renames the app's own jobs wherever they were stored", () => {
    const db = fresh();
    db.query(
      "INSERT INTO workflows(id,title,instruction,executor_json,created_at,updated_at) VALUES ('w','t','i',?,'now','now')",
    ).run(
      JSON.stringify({
        kind: "script",
        path: "jobs/collection.ts",
        args: ["a"],
        capabilities: ["account.read"],
      }),
    );
    db.exec(`PRAGMA user_version = ${V14.version - 1}`);
    expect(migrate(db)).toBe(1);
    expect(db.query("SELECT executor_json FROM workflows WHERE id='w'").get()).toEqual({
      executor_json: JSON.stringify({
        kind: "script",
        path: "@builtin/collection.ts",
        args: ["a"],
        capabilities: ["account.read"],
      }),
    });
  });

  test("v13 gives an older database the queue table it lacks", () => {
    const db = fresh();
    db.exec("DROP TABLE session_queue");
    db.exec(`PRAGMA user_version = ${V14.version - 2}`);
    // OUTSIDE the transaction: whether a step runs is decided by the version read
    // here, so a no-op body cannot satisfy a step whose schema is missing.
    const ran = migrate(db);
    // v12 is retired, so the two kept steps (v13, v14) both run here.
    expect(ran).toBe(2);
    expect(
      db.query("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='session_queue'").get(),
    ).toEqual({
      n: 1,
    });
  });
});
