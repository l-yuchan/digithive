import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate } from "../src/store/db";
import { correctMemory, listMemories, recallMemories, remember } from "../src/knowledge/memory";
import { validCitations } from "../src/knowledge/citations";
import { readStoredFile, storeFile } from "../src/files/store";
import {
  normalizeCanvasAssignment,
  normalizeCalendarEvent,
  normalizeGmail,
} from "../src/integrations/normalize";

function db(): Database {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  migrate(database);
  return database;
}

describe("memory", () => {
  test("recall returns only live matching memories", () => {
    const database = db();
    remember(database, { kind: "interest", text: "회의는 화요일 오전에 선호" });
    remember(database, { kind: "fact", text: "선호 시간대는 저녁" });
    expect(recallMemories(database, "회의").map((memory) => memory.text)).toEqual([
      "회의는 화요일 오전에 선호",
    ]);
    expect(recallMemories(database, "없는단어")).toHaveLength(0);
  });

  test("correcting a memory keeps the old row but hides it from recall", () => {
    const database = db();
    const original = remember(database, { kind: "fact", text: "회의는 화요일" });
    const fixed = correctMemory(database, { id: original.id, text: "회의는 수요일" });
    expect(fixed?.text).toBe("회의는 수요일");

    expect(recallMemories(database, "회의").map((memory) => memory.text)).toEqual([
      "회의는 수요일",
    ]);
    const all = listMemories(database, true);
    expect(all).toHaveLength(2);
    expect(all.find((memory) => memory.id === original.id)?.supersededBy).toBe(fixed?.id);
  });

  test("citations to sources the model never saw are dropped", () => {
    const kept = validCitations(
      [
        { sourceId: "mail:1", quote: "내일 마감" },
        { sourceId: "mail:9", quote: "지어낸 인용" },
        { sourceId: "mail:1", quote: "   " },
      ],
      ["mail:1"],
    );
    expect(kept).toEqual([{ sourceId: "mail:1", quote: "내일 마감" }]);
  });
});

describe("file store", () => {
  test("a stored file round-trips through disk", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-files-"));
    try {
      const database = db();
      const stored = storeFile(database, root, {
        name: "회의 준비.txt",
        mime: "text/plain",
        bytes: new TextEncoder().encode("준비물 목록"),
      });
      expect(stored.sha256).toHaveLength(64);
      const read = readStoredFile(database, stored.id);
      expect(read?.meta.name).toBe("회의 준비.txt");
      expect(new TextDecoder().decode(read?.bytes)).toBe("준비물 목록");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("integration normalization", () => {
  test("gmail payload normalizes headers and a base64url body", () => {
    const body = Buffer.from("본문 내용입니다", "utf8").toString("base64url");
    const item = normalizeGmail({
      id: "m1",
      internalDate: "1795500000000",
      snippet: "스니펫",
      payload: {
        headers: [
          { name: "Subject", value: "회의 안내" },
          { name: "From", value: "a@b.c" },
        ],
        body: { data: body },
      },
    });
    expect(item).toMatchObject({
      id: "m1",
      source: "gmail",
      title: "회의 안내",
      detail: "본문 내용입니다",
    });
    expect(item.at).toBe(new Date(1795500000000).toISOString());
  });

  test("calendar and canvas payloads keep their due time and source", () => {
    const event = normalizeCalendarEvent({
      id: "e1",
      summary: "팀 회의",
      start: { dateTime: "2026-11-24T10:00:00+09:00" },
    });
    expect(event).toMatchObject({
      source: "calendar",
      title: "팀 회의",
      at: "2026-11-24T10:00:00+09:00",
    });

    const assignment = normalizeCanvasAssignment({
      id: 7,
      name: "보고서",
      due_at: "2026-11-30T14:59:00Z",
      course_id: 3,
    });
    expect(assignment).toMatchObject({
      source: "canvas",
      title: "보고서",
      at: "2026-11-30T14:59:00Z",
    });
    expect(assignment.detail).toContain("과목 3");
  });
});
