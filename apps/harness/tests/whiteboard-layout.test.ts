import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/store/db";
import { createWhiteboardStore, WHITEBOARD_SCHEMA_SQL } from "../src/whiteboard/store";

/**
 * The 2026-11-28 layout move: existing documents are reindexed at their navigable path while
 * their ids stay put, and a reference written against the old path still resolves.
 */

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "whiteboard-move-"));
  const db = new Database(":memory:");
  migrate(db);
  db.exec(WHITEBOARD_SCHEMA_SQL);
  const root = join(directory, "board");
  const store = createWhiteboardStore(db, root);
  return {
    db,
    root,
    store,
    cleanup: () => {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("a document from the old layout is reindexed at its new path with its id kept", () => {
  const fixture = setup();
  try {
    // Given a document written by the previous build (id carries the old path).
    const old = fixture.store.write({
      path: "threads/notes/meeting",
      kind: "thread",
      title: "주간 회의",
      text: "회의 안건",
      source: { type: "user", id: "owner" },
    });
    fixture.db.exec("DELETE FROM whiteboard_documents");
    fixture.db.exec("DELETE FROM whiteboard_fts");
    fixture.store.refresh();
    // When the indexer reads it again, its path and id agree and nothing is lost.
    const [again] = fixture.store.list({ query: "회의" });
    expect(again?.id).toBe(old.id);
    expect(again?.path).toBe("threads/notes/meeting.md");
    expect(readFileSync(join(fixture.root, "threads/notes/meeting.md"), "utf8")).toContain(
      "회의 안건",
    );
  } finally {
    fixture.cleanup();
  }
});

test("a citation by an old path resolves to the document after the layout moved", () => {
  const fixture = setup();
  try {
    // Given a document, then a rename of its file (as the layout move does).
    const note = fixture.store.write({
      path: "threads/briefings/old-briefing",
      kind: "thread",
      title: "이전 브리핑",
      text: "본문",
      source: { type: "user", id: "owner" },
    });
    const from = join(fixture.root, note.path);
    const to = join(fixture.root, "briefings/2026-11-28-0730.md");
    mkdirSync(join(fixture.root, "briefings"), { recursive: true });
    writeFileSync(to, readFileSync(from, "utf8"));
    rmSync(from);
    fixture.store.refresh();
    // Then the reference by the path it was written with still names the document.
    const resolved = fixture.store.resolvePath("threads/briefings/old-briefing.md");
    expect(resolved).not.toBeNull();
    expect(fixture.store.read(note.id)?.path).toBe(resolved ?? "");
    expect(fixture.store.resolvePath("briefings/2026-11-28-0730")).toBe(
      "briefings/2026-11-28-0730.md",
    );
    expect(fixture.store.resolvePath("briefings/nothing")).toBeNull();
  } finally {
    fixture.cleanup();
  }
});
