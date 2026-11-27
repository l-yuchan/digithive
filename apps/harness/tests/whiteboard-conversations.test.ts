import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEntry, createSession } from "../src/core/sessions";
import { openDatabase } from "../src/store/db";
import { createWhiteboardStore } from "../src/whiteboard/store";

test("every persisted conversation entry becomes searchable filesystem evidence", () => {
  // Given two entries written through the product session storage seam.
  const directory = mkdtempSync(join(tmpdir(), "whiteboard-conversations-"));
  const db = openDatabase(":memory:");
  const store = createWhiteboardStore(db, join(directory, "board"));
  try {
    const session = createSession(db, "조사 대화", Date.parse("2026-11-27T00:00:00Z"));
    const user = appendEntry(db, {
      sessionId: session.id,
      kind: "message",
      role: "user",
      events: [{ type: "text", id: 0, text: "오늘 회의 자료를 검토해줘" }],
      now: Date.parse("2026-11-27T00:00:00Z"),
    });
    const assistant = appendEntry(db, {
      sessionId: session.id,
      kind: "message",
      role: "assistant",
      events: [
        { type: "text", id: 0, text: "회의에 필요한 근거를 찾았습니다." },
        {
          type: "tool_result",
          id: 1,
          callId: "web-search-1",
          name: "web_search",
          detail: "공식 문서를 근거로 정리했습니다.",
        },
      ],
      now: Date.parse("2026-11-27T00:01:00Z"),
    });
    // When the canonical filesystem is indexed twice.
    const documents = () =>
      store
        .list({ kind: "record", query: "회의", limit: 50 })
        .filter((document) => document.source["type"] === "conversation");
    const firstDocuments = documents();
    const firstPaths = firstDocuments.map((document) => document.path);
    // Then both stored entries exist once, with stable source/session identity and readable content.
    const ids = firstDocuments.map((document) => String(document.source["entryId"]));
    expect(ids.toSorted((left, right) => left.localeCompare(right))).toEqual(
      [assistant.id, user.id].toSorted((left, right) => left.localeCompare(right)),
    );
    const userDocument = firstDocuments.find((document) => document.source["entryId"] === user.id);
    expect(userDocument ? store.read(userDocument.id)?.text : null).toContain(
      "오늘 회의 자료를 검토해줘",
    );
    expect(documents().map((document) => document.path)).toEqual(firstPaths);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
