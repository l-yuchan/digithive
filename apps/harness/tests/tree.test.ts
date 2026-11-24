import { ok } from "node:assert/strict";
import { describe, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { migrate } from "../src/store/db";
import {
  appendEntry,
  createSession,
  listEntries,
  renameSession,
  softDeleteSession,
  updateEntryParts,
} from "../src/core/sessions";
import {
  forkSession,
  getLeaf,
  pathEntries,
  regeneratePoint,
  searchSessions,
  setLeaf,
  editUserMessage,
  deepestDescendant,
} from "../src/core/tree";

function setup() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  const session = createSession(db, "테스트 대화");
  return { db, sessionId: session.id };
}

describe("conversation tree", () => {
  test("editing a user message keeps the original and moves the leaf to a sibling", () => {
    const { db, sessionId } = setup();
    const first = appendEntry(db, {
      sessionId,
      kind: "message",
      role: "user",
      parts: [{ type: "text", text: "회의 일정 알려줘" }],
    });
    const answer = appendEntry(db, {
      sessionId,
      parentId: first.id,
      kind: "message",
      role: "assistant",
      parts: [{ type: "text", text: "답변" }],
    });
    setLeaf(db, sessionId, answer.id);

    const edit = editUserMessage(db, {
      sessionId,
      entryId: first.id,
      text: "회의 일정을 내일 기준으로 알려줘",
    });
    expect(edit.entry.parentId).toBe(first.parentId);
    expect(edit.entry.id).not.toBe(first.id);
    expect(getLeaf(db, sessionId)).toBe(edit.entry.id);

    const all = listEntries(db, sessionId);
    expect(all.find((entry) => entry.id === first.id)?.parts).toEqual([
      { type: "text", text: "회의 일정 알려줘" },
    ]);

    const path = pathEntries(db, sessionId);
    expect(path.map((entry) => entry.id)).toEqual([edit.entry.id]);
    expect(path.some((entry) => entry.id === answer.id)).toBe(false);
  });

  test("pathEntries follows the leaf's ancestors, not insertion order", () => {
    const { db, sessionId } = setup();
    const u1 = appendEntry(db, {
      sessionId,
      kind: "message",
      role: "user",
      parts: [{ type: "text", text: "첫 질문" }],
    });
    const a1 = appendEntry(db, {
      sessionId,
      parentId: u1.id,
      kind: "message",
      role: "assistant",
      parts: [{ type: "text", text: "첫 답" }],
    });
    const u2 = appendEntry(db, {
      sessionId,
      parentId: a1.id,
      kind: "message",
      role: "user",
      parts: [{ type: "text", text: "둘째 질문" }],
    });
    const a2 = appendEntry(db, {
      sessionId,
      parentId: u2.id,
      kind: "message",
      role: "assistant",
      parts: [{ type: "text", text: "둘째 답" }],
    });
    setLeaf(db, sessionId, a2.id);
    expect(pathEntries(db, sessionId).map((entry) => entry.id)).toEqual([
      u1.id,
      a1.id,
      u2.id,
      a2.id,
    ]);

    setLeaf(db, sessionId, a1.id);
    expect(pathEntries(db, sessionId).map((entry) => entry.id)).toEqual([u1.id, a1.id]);
  });

  test("regenerate points at the parent user message and starts from its text", () => {
    const { db, sessionId } = setup();
    const user = appendEntry(db, {
      sessionId,
      kind: "message",
      role: "user",
      parts: [{ type: "text", text: "다시 답해줘" }],
    });
    const answer = appendEntry(db, {
      sessionId,
      parentId: user.id,
      kind: "message",
      role: "assistant",
      parts: [{ type: "text", text: "이전 답" }],
    });
    const point = regeneratePoint(db, { sessionId, entryId: answer.id });
    expect(point.parentId).toBe(user.id);
    expect(point.userText).toBe("다시 답해줘");
    expect(getLeaf(db, sessionId)).toBe(user.id);
    expect(() => regeneratePoint(db, { sessionId, entryId: user.id })).toThrow();
  });

  test("fork copies only the ancestor chain into a new session", () => {
    const { db, sessionId } = setup();
    const u1 = appendEntry(db, {
      sessionId,
      kind: "message",
      role: "user",
      parts: [{ type: "text", text: "원본 질문" }],
    });
    const a1 = appendEntry(db, {
      sessionId,
      parentId: u1.id,
      kind: "message",
      role: "assistant",
      parts: [{ type: "text", text: "원본 답" }],
    });
    const u2 = appendEntry(db, {
      sessionId,
      parentId: a1.id,
      kind: "message",
      role: "user",
      parts: [{ type: "text", text: "이어지는 질문" }],
    });

    const forked = forkSession(db, { sessionId, entryId: a1.id, title: "분기 대화" });
    const copied = pathEntries(db, forked.sessionId);
    expect(copied.map((entry) => entry.role)).toEqual(["user", "assistant"]);
    expect(copied.map((entry) => entry.parts)).toEqual([
      [{ type: "text", text: "원본 질문" }],
      [{ type: "text", text: "원본 답" }],
    ]);
    expect(copied.some((entry) => entry.id === u2.id)).toBe(false);
    expect(listEntries(db, sessionId)).toHaveLength(3);
  });

  test("rename updates the title and rejects an empty one", () => {
    const { db, sessionId } = setup();
    expect(renameSession(db, sessionId, "새 제목")?.title).toBe("새 제목");
    expect(renameSession(db, sessionId, "   ")).toBeNull();
  });

  test("soft delete hides the session and cancels live runs", () => {
    const { db, sessionId } = setup();
    db.query(
      "INSERT INTO runs (id, session_id, origin, goal, status, budget_json, created_at) VALUES ('r1', ?, 'conversation', 'g', 'running', '{}', 'now')",
    ).run(sessionId);
    const result = softDeleteSession(db, sessionId);
    expect(result.cancelledRuns).toBe(1);
    const run = db
      .query<{ status: string; cancel_intent: string }, SQLQueryBindings[]>(
        "SELECT status, cancel_intent FROM runs WHERE id = 'r1'",
      )
      .get();
    ok(run, "fixture row exists");
    expect(run).toEqual({ status: "cancelled", cancel_intent: "policy" });
    const visible = db.query("SELECT id FROM sessions WHERE deleted_at IS NULL").all();
    expect(visible).toHaveLength(0);
  });

  test("switching to a sibling branch lands on that branch's deepest turn, not the bare message", () => {
    const { db, sessionId } = setup();
    const u1 = appendEntry(db, {
      sessionId,
      kind: "message",
      role: "user",
      parts: [{ type: "text", text: "원래 질문" }],
    });
    const a1 = appendEntry(db, {
      sessionId,
      parentId: u1.id,
      kind: "message",
      role: "assistant",
      parts: [{ type: "text", text: "원래 답" }],
    });
    const u2 = appendEntry(db, {
      sessionId,
      parentId: u1.parentId,
      kind: "message",
      role: "user",
      parts: [{ type: "text", text: "수정한 질문" }],
    });
    const a2 = appendEntry(db, {
      sessionId,
      parentId: u2.id,
      kind: "message",
      role: "assistant",
      parts: [{ type: "text", text: "수정한 답" }],
    });
    setLeaf(db, sessionId, a2.id);

    const target = deepestDescendant(db, sessionId, u1.id);
    expect(target).toBe(a1.id);
    setLeaf(db, sessionId, target);
    expect(pathEntries(db, sessionId).map((entry) => entry.id)).toEqual([u1.id, a1.id]);
  });

  test("search finds Korean text in message bodies", () => {
    const { db, sessionId } = setup();
    const user = appendEntry(db, {
      sessionId,
      kind: "message",
      role: "user",
      parts: [{ type: "text", text: "내일 회의 준비물을 정리해줘" }],
    });
    updateEntryParts(
      db,
      user.id,
      [{ type: "text", text: "내일 회의 준비물을 정리해줘" }],
      "complete",
      sessionId,
    );
    expect(searchSessions(db, "회의").map((row) => row.id)).toContain(sessionId);
    expect(searchSessions(db, "준비물").map((row) => row.id)).toContain(sessionId);
    expect(searchSessions(db, "없는단어")).toHaveLength(0);
  });
});
