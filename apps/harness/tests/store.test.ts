import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { migrate, openDatabase } from "../src/store/db";
import { MIGRATIONS } from "../src/store/migrations";

function memoryDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

describe("store migrations", () => {
  test("creates every table from the plan schema", () => {
    const db = memoryDb();
    const names = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    for (const table of ["approvals", "entries", "events", "parts", "runs", "saved_approvals", "sessions", "tool_calls"]) {
      expect(names).toContain(table);
    }
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(MIGRATIONS.length);
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
        .query("INSERT INTO entries (id, session_id, kind, payload_json, created_at, seq) VALUES ('e1','missing','message','{}','now',1)")
        .run(),
    ).toThrow();
  });

  test("openDatabase works on a file and is idempotent across connections", () => {
    const dir = import.meta.dir;
    const path = `${dir}/tmp-store-${crypto.randomUUID()}.db`;
    const first = openDatabase(path);
    first.close();
    const second = openDatabase(path);
    expect((second.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(MIGRATIONS.length);
    second.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(path + suffix);
      } catch {
        // absent file is fine
      }
    }
  });
});
