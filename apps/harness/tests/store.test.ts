import { describe, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDatabase, OLDEST_OPENABLE } from "../src/store/db";
import { LATEST, RESET_VERSION, V13, V15 } from "../src/store/migrations";

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
    expect(migrate(db)).toBe(1);
    // The queue table is in the reset itself; only the newest step runs on top of it.
    expect(version(db)).toBe(LATEST);
    expect(
      db.query("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='session_queue'").get(),
    ).toEqual({ n: 1 });
  });

  test("a database one version behind runs exactly the step it lacks", () => {
    const db = fresh();
    db.exec(`PRAGMA user_version = ${V15.version - 1}`);
    expect(migrate(db)).toBe(1);
    expect(version(db)).toBe(LATEST);
  });

  test("a database recorded before the reset gets the queue table it lacks", () => {
    // A real v13 database has the queue table; one that only claims v13 and lacks it is
    // the case that used to be stamped to the newest version without being repaired.
    const db = fresh();
    db.exec("DROP TABLE session_queue");
    db.exec(`PRAGMA user_version = ${V13.version - 1}`);
    const ran = migrate(db);
    expect(ran).toBe(1);
    expect(version(db)).toBe(LATEST);
    expect(
      db.query("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='session_queue'").get(),
    ).toEqual({
      n: 1,
    });
  });
});
