import { expect, test } from "bun:test";
import { openDatabase } from "../src/store/db";
import { createWhiteboardStore } from "../src/whiteboard/store";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("search does not match raw provenance keys or punctuation", () => {
  // Given a document whose only id-like text exists in the provenance record.
  const directory = mkdtempSync(join(tmpdir(), "whiteboard-index-"));
  const db = openDatabase(":memory:");
  const store = createWhiteboardStore(db, join(directory, "board"));
  try {
    store.write({
      path: "threads/notes/provenance-only",
      kind: "thread",
      title: "출처 검사",
      text: "메타데이터만 다른 문서",
      source: { type: "user", id: "owner-public" },
    });
    // When a user searches a JSON key and plausible provenance text.
    // Then the key/punctuation is irrelevant, while the actual source value is findable.
    expect(store.list({ query: "id", kind: "thread" })).toEqual([]);
    expect(store.list({ query: "owner", kind: "thread" }).map((row) => row.path)).toEqual([
      "threads/notes/provenance-only.md",
    ]);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
