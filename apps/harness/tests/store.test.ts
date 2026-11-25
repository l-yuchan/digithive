import { describe, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDatabase, OLDEST_OPENABLE } from "../src/store/db";
import { LATEST, RESET_VERSION, V12 } from "../src/store/migrations";

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

describe("a transition is one transaction", () => {
  /** A database at the latest schema with one entry stored in the pre-event form. */
  function withLegacyEntry(): Database {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
    db.query(
      "INSERT INTO sessions(id,title,created_at,updated_at) VALUES ('s','kept','now','now')",
    ).run();
    db.query(
      "INSERT INTO entries(id,session_id,kind,role,payload_json,created_at,seq) VALUES ('e','s','message','user',?,'now',1)",
    ).run(JSON.stringify({ parts: [{ type: "text", text: "original" }] }));
    db.exec(`PRAGMA user_version = ${V12.version - 1}`);
    return db;
  }

  test("the version bump and the payload rewrite commit together", () => {
    const db = withLegacyEntry();
    try {
      expect(migrate(db)).toBe(1);
      expect(version(db)).toBe(LATEST);
      expect(db.query("SELECT payload_json FROM entries WHERE id='e'").get()).toEqual({
        payload_json: JSON.stringify({ events: [{ type: "text", id: 0, text: "original" }] }),
      });
    } finally {
      db.close();
    }
  });

  test("a rewrite that throws leaves the rows and the version untouched", () => {
    const db = withLegacyEntry();
    try {
      db.exec("CREATE TRIGGER boom BEFORE UPDATE ON entries BEGIN SELECT RAISE(ABORT,'boom'); END");
      expect(() => migrate(db)).toThrow("boom");
      expect(version(db)).toBe(V12.version - 1);
      expect(db.query("SELECT payload_json FROM entries WHERE id='e'").get()).toEqual({
        payload_json: JSON.stringify({ parts: [{ type: "text", text: "original" }] }),
      });
    } finally {
      db.close();
    }
  });
});
