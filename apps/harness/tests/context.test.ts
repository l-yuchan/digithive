import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../src/store/db";
import { appendEntry, createSession, listEntries } from "../src/core/sessions";
import { buildContext, clockLine, systemPrompt } from "../src/core/context";
import { latestCompaction, maybeCompact } from "../src/core/compaction";

function db(): Database {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  migrate(database);
  return database;
}

const FIXED = Date.parse("2026-11-24T05:34:56.000Z"); // 14:34:56 KST

describe("context assembly", () => {
  test("the clock line carries the Asia/Seoul wall clock for a fixed instant", () => {
    expect(clockLine(FIXED)).toBe("현재 시각: 2026-11-24 (화요일) 14:34:56 Asia/Seoul · 2026-11-24T05:34:56.000Z");
    expect(systemPrompt(FIXED)).toContain("2026-11-24 (화요일) 14:34:56");
  });

  test("instruction blocks survive budget pressure and only history is trimmed", () => {
    const history = Array.from({ length: 40 }, (_, index) => ({
      role: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: "가".repeat(100),
    }));
    const built = buildContext({ now: FIXED, history, budget: { maxChars: 3_000 } });
    expect(built.system).toContain("현재 시각: 2026-11-24");
    expect(built.system).toContain("외부 행동");
    expect(built.dropped).toBeGreaterThan(0);
    expect(built.messages.at(-1)?.content).toBe(history.at(-1)?.content);
    expect(built.system.length + built.messages.reduce((sum, message) => sum + message.content.length, 0)).toBeLessThanOrEqual(3_000);
  });

  test("compaction summary is placed in the system block, not as a fake user turn", () => {
    const built = buildContext({
      now: FIXED,
      history: [{ role: "user", content: "최근 질문" }],
      compaction: { summary: "이전에는 회의 일정을 정리했다.", coversSeq: 10 },
    });
    expect(built.system).toContain("이전에는 회의 일정을 정리했다.");
    expect(built.messages).toEqual([{ role: "user", content: "최근 질문" }]);
  });

  test("tool descriptions are listed only when tools exist", () => {
    const without = buildContext({ now: FIXED, history: [] });
    expect(without.system).not.toContain("사용 가능한 도구");
    const withTools = buildContext({ now: FIXED, history: [], tools: [{ name: "search", description: "자료 검색" }] });
    expect(withTools.system).toContain("- search: 자료 검색");
  });
});

describe("compaction", () => {
  test("below the threshold nothing is compacted", async () => {
    const database = db();
    const session = createSession(database, "짧은 대화");
    appendEntry(database, { sessionId: session.id, kind: "message", role: "user", parts: [{ type: "text", text: "짧은 질문" }] });
    const result = await maybeCompact({ db: database, sessionId: session.id, summarize: async () => "요약", maxChars: 10_000 });
    expect(result.compacted).toBe(false);
    expect(latestCompaction(database, session.id)).toBeNull();
  });

  test("older messages collapse into one compaction entry and originals are preserved", async () => {
    const database = db();
    const session = createSession(database, "긴 대화");
    for (let index = 0; index < 8; index += 1) {
      appendEntry(database, {
        sessionId: session.id,
        kind: "message",
        role: index % 2 === 0 ? "user" : "assistant",
        parts: [{ type: "text", text: `메시지 ${index} `.padEnd(60, "가") }],
      });
    }
    const before = listEntries(database, session.id).length;
    const transcriptSeen: string[] = [];
    const result = await maybeCompact({
      db: database,
      sessionId: session.id,
      summarize: async (transcript) => {
        transcriptSeen.push(transcript);
        return "앞선 네 번의 대화를 요약했다.";
      },
      maxChars: 200,
    });
    expect(result.compacted).toBe(true);
    expect(result.coveredMessages).toBe(4);
    expect(transcriptSeen[0]).toContain("메시지 0");
    expect(transcriptSeen[0]).not.toContain("메시지 7");

    const view = latestCompaction(database, session.id);
    expect(view?.summary).toBe("앞선 네 번의 대화를 요약했다.");
    expect(view?.coversSeq).toBeGreaterThan(0);

    const after = listEntries(database, session.id);
    expect(after.length).toBe(before + 1);
    expect(after.filter((entry) => entry.kind === "compaction")).toHaveLength(1);
    expect(after.filter((entry) => entry.kind === "message")).toHaveLength(8);
  });

  test("a second compaction does not re-summarize what the first one already covered", async () => {
    const database = db();
    const session = createSession(database, "반복 압축");
    for (let index = 0; index < 8; index += 1) {
      appendEntry(database, {
        sessionId: session.id,
        kind: "message",
        role: index % 2 === 0 ? "user" : "assistant",
        parts: [{ type: "text", text: `반복 메시지 ${index} `.padEnd(60, "나") }],
      });
    }
    const first = await maybeCompact({ db: database, sessionId: session.id, summarize: async () => "첫 요약", maxChars: 200 });
    expect(first.compacted).toBe(true);
    const second = await maybeCompact({ db: database, sessionId: session.id, summarize: async () => "둘째 요약", maxChars: 200 });
    expect(second.compacted).toBe(false);
    expect(latestCompaction(database, session.id)?.summary).toBe("첫 요약");
  });
});
