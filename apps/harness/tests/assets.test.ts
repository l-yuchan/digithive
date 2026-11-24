import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate } from "../src/store/db";
import { EventLog } from "../src/events/log";
import { correctMemory, listMemories, recallMemories, remember } from "../src/knowledge/memory";
import { validCitations } from "../src/knowledge/citations";
import { readStoredFile, storeFile } from "../src/files/store";
import { normalizeCanvasAssignment, normalizeCalendarEvent, normalizeGmail, syncSource, syncStates } from "../src/integrations/normalize";
import { briefingRunRequest, nextBriefingAt, sendBriefingPush } from "../src/scheduler/briefing";

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
    expect(recallMemories(database, "회의").map((memory) => memory.text)).toEqual(["회의는 화요일 오전에 선호"]);
    expect(recallMemories(database, "없는단어")).toHaveLength(0);
  });

  test("correcting a memory keeps the old row but hides it from recall", () => {
    const database = db();
    const original = remember(database, { kind: "fact", text: "회의는 화요일" });
    const fixed = correctMemory(database, { id: original.id, text: "회의는 수요일" });
    expect(fixed?.text).toBe("회의는 수요일");

    expect(recallMemories(database, "회의").map((memory) => memory.text)).toEqual(["회의는 수요일"]);
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
      const stored = storeFile(database, root, { name: "회의 준비.txt", mime: "text/plain", bytes: new TextEncoder().encode("준비물 목록") });
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
      payload: { headers: [{ name: "Subject", value: "회의 안내" }, { name: "From", value: "a@b.c" }], body: { data: body } },
    });
    expect(item).toMatchObject({ id: "m1", source: "gmail", title: "회의 안내", detail: "본문 내용입니다" });
    expect(item.at).toBe(new Date(1795500000000).toISOString());
  });

  test("calendar and canvas payloads keep their due time and source", () => {
    const event = normalizeCalendarEvent({ id: "e1", summary: "팀 회의", start: { dateTime: "2026-11-24T10:00:00+09:00" } });
    expect(event).toMatchObject({ source: "calendar", title: "팀 회의", at: "2026-11-24T10:00:00+09:00" });

    const assignment = normalizeCanvasAssignment({ id: 7, name: "보고서", due_at: "2026-11-30T14:59:00Z", course_id: 3 });
    expect(assignment).toMatchObject({ source: "canvas", title: "보고서", at: "2026-11-30T14:59:00Z" });
    expect(assignment.detail).toContain("과목 3");
  });

  test("a failing source is recorded as ok:false with the failing source named", async () => {
    const database = db();
    const events = new EventLog(database);
    const outcome = await syncSource({
      db: database,
      events,
      source: "gmail",
      cursor: null,
      collect: async () => {
        throw new Error("403 quota exceeded");
      },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe("403 quota exceeded");
    const states = syncStates(database);
    expect(states).toEqual([{ source: "gmail", ok: false, lastSyncAt: expect.any(String), error: "403 quota exceeded" }]);
    const emitted = events.after(0).find((event) => event.kind === "integration.sync_state");
    expect(emitted?.payload).toMatchObject({ source: "gmail", ok: false });
  });

  test("a successful source records its cursor and count", async () => {
    const database = db();
    const events = new EventLog(database);
    const outcome = await syncSource({
      db: database,
      events,
      source: "calendar",
      cursor: null,
      collect: async () => ({ items: [normalizeCalendarEvent({ id: "e1", summary: "회의" })], cursor: "cursor-2" }),
    });
    expect(outcome).toMatchObject({ ok: true, count: 1, cursor: "cursor-2" });
    expect(syncStates(database)[0]).toMatchObject({ source: "calendar", ok: true, error: null });
  });
});

describe("briefing scheduler", () => {
  test("the next slot is the coming 07:30 KST from an early-morning instant", () => {
    const now = Date.parse("2026-11-24T00:10:00+09:00");
    expect(new Date(nextBriefingAt(now)).toISOString()).toBe("2026-11-23T22:30:00.000Z");
  });

  test("after the morning slot the next one is 21:00 KST", () => {
    const now = Date.parse("2026-11-24T07:31:00+09:00");
    expect(new Date(nextBriefingAt(now)).toISOString()).toBe("2026-11-24T12:00:00.000Z");
  });

  test("after the evening slot it rolls to tomorrow 07:30 KST", () => {
    const now = Date.parse("2026-11-24T21:05:00+09:00");
    expect(new Date(nextBriefingAt(now)).toISOString()).toBe("2026-11-24T22:30:00.000Z");
    const request = briefingRunRequest(now);
    expect(request.slot).toBe("07:30");
    expect(request.dueAt).toBe("2026-11-24T22:30:00.000Z");
  });

  test("push failure is returned as a visible error, not swallowed", async () => {
    const failed = await sendBriefingPush(async () => ({ ok: false, error: "no_subscription" }), { title: "브리핑", body: "내용" });
    expect(failed).toMatchObject({ ok: false, error: "no_subscription" });
    const threw = await sendBriefingPush(async () => {
      throw new Error("network");
    }, { title: "브리핑", body: "내용" });
    expect(threw).toMatchObject({ ok: false, error: "network" });
    const sent = await sendBriefingPush(async () => ({ ok: true }), { title: "브리핑", body: "내용" });
    expect(sent.ok).toBe(true);
  });
});
