import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWhiteboardStore, WHITEBOARD_SCHEMA_SQL } from "../src/whiteboard/store";
import { indexWhiteboard, queryIndex } from "../src/whiteboard/sqlite-index";

/** Rows changed so far on one connection, read on that same connection. */
function changes(db: Database): number {
  return db.query<{ n: number }, []>("SELECT total_changes() AS n").get()?.n ?? 0;
}

/**
 * Live 2026-11-28: the worker died with SQLITE_BUSY on `DELETE FROM whiteboard_fts` while it
 * started (1,223 documents) and the web container held the database. The indexer now writes
 * only what changed, so a plain refresh takes no write lock at all, and a write that does
 * collide waits for the other writer instead of throwing.
 */

/** A second connection to the same file, closed with the ones the store holds. */
function open(directory: string) {
  const connections: Database[] = [];
  const connect = () => {
    const db = new Database(join(directory, "main.db"), { create: true });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    // The parent-owned migration creates these in production; here the schema is explicit.
    db.exec(WHITEBOARD_SCHEMA_SQL);
    connections.push(db);
    return db;
  };
  const primary = connect();
  const store = createWhiteboardStore(primary, join(directory, "board"));
  return {
    db: () => connect(),
    store: Object.assign(store, { db: () => primary }),
    close: () => {
      for (const db of connections) db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("refreshing an unchanged board writes nothing", () => {
  const fixture = open(mkdtempSync(join(tmpdir(), "whiteboard-incremental-")));
  try {
    for (let index = 0; index < 5; index += 1)
      fixture.store.write({
        path: `threads/notes/note-${index}`,
        kind: "thread",
        title: `노트 ${index}`,
        text: `본문 ${index}`,
        source: { type: "user", id: "owner" },
      });
    // Given a board that is already indexed, the store's own connection reports its writes.
    const primary = fixture.store.db();
    const before = changes(primary);
    // When the indexer runs with nothing changed (a refresh also re-projects, which needs
    // the full schema; the indexer alone is what is measured here).
    indexWhiteboard(primary, fixture.store.root);
    const after = changes(primary);
    // Then it wrote nothing: no delete-and-refill and no FTS refill.
    // (A real edit does move this counter, so the measurement is not inert.)
    const [first] = queryIndex(primary, { query: "노트 0" });
    if (first) fixture.store.update({ id: first.id, expectedHash: first.hash, status: "archived" });
    expect(changes(primary)).toBeGreaterThan(after);
    expect(after - before).toBe(0);
    // And the unchanged documents are still found through the same index.
    expect(queryIndex(primary, { query: "본문" })).toHaveLength(5);
  } finally {
    fixture.close();
  }
});

test("a write waits for another writer instead of failing with SQLITE_BUSY", () => {
  const directory = mkdtempSync(join(tmpdir(), "whiteboard-busy-"));
  const fixture = open(directory);
  let holder: ReturnType<typeof spawn> | null = null;
  try {
    fixture.store.write({
      path: "threads/notes/first",
      kind: "thread",
      title: "첫 노트",
      text: "처음",
      source: { type: "user", id: "owner" },
    });
    // Given another process holding the write lock for 300ms, as the other container would.
    // (A timer cannot fire while this thread is blocked inside the write.)
    const script = join(directory, "holder.ts");
    writeFileSync(
      script,
      `import { Database } from "bun:sqlite";\n` +
        `const db = new Database(${JSON.stringify(join(directory, "main.db"))});\n` +
        `db.exec("PRAGMA busy_timeout = 5000");\n` +
        `db.exec("BEGIN IMMEDIATE");\n` +
        `db.exec("INSERT INTO whiteboard_fts (document_id,path,text) VALUES ('wb_lock','lock','lock')");\n` +
        `await Bun.sleep(300);\n` +
        `db.exec("COMMIT");\n` +
        `db.close();\n`,
    );
    holder = spawn(process.execPath, [script], { stdio: "ignore" });
    // Wait until the other process actually holds the lock before writing.
    const heldUntil = Date.now() + 3_000;
    for (;;) {
      const probe = new Database(join(directory, "main.db"));
      try {
        probe.exec("BEGIN IMMEDIATE");
        probe.exec("ROLLBACK");
        probe.close();
      } catch {
        probe.close();
        break;
      }
      if (Date.now() > heldUntil) throw new Error("holder_never_locked");
      Bun.sleepSync(20);
    }
    // When the board writes during that window.
    const written = fixture.store.write({
      path: "threads/notes/second",
      kind: "thread",
      title: "둘째 노트",
      text: "두 번째",
      source: { type: "user", id: "owner" },
    });
    // Then it completes once the lock is released rather than throwing.
    expect(written.path).toBe("threads/notes/second.md");
  } finally {
    holder?.kill();
    fixture.close();
  }
});
