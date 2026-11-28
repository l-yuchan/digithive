import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EventLog } from "../src/events/log";
import { migrate } from "../src/store/db";
import {
  DEFAULT_CANVAS_ACCOUNT_ID,
  DEFAULT_GOOGLE_ACCOUNT_ID,
  setSourceEnabled,
} from "../src/integrations/accounts";
import { saveItems } from "../src/integrations/sync-store";
import { createBinding } from "../src/scheduler/schedule-store";
import { enqueueRun } from "../src/surfaces/work/runner";
import { WHITEBOARD_SCHEMA_SQL, createWhiteboardStore } from "../src/whiteboard/store";
import {
  WhiteboardConflictError,
  WhiteboardError,
  WhiteboardPathError,
  type WhiteboardStore,
} from "../src/whiteboard/types";
import { createWorkflow } from "../src/workflows/workflow-store";

const NOW = Date.parse("2026-11-27T09:00:00.000Z");
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup(): { db: Database; root: string; store: WhiteboardStore } {
  const directory = mkdtempSync(join(tmpdir(), "whiteboard-"));
  const db = new Database(":memory:");
  migrate(db);
  db.exec(WHITEBOARD_SCHEMA_SQL);
  db.exec(WHITEBOARD_SCHEMA_SQL); // index creation is idempotent
  const root = join(directory, "root");
  const store = createWhiteboardStore(db, root);
  cleanups.push(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { db, root, store };
}

function writeNote(
  store: WhiteboardStore,
  path: string,
  title: string,
  text: string,
): ReturnType<WhiteboardStore["write"]> {
  return store.write({ path, kind: "thread", title, text, source: { type: "user" }, now: NOW });
}

describe("whiteboard store", () => {
  test("Korean note/commitment keep ids on status update (regression: duplicate or lost task)", () => {
    // Regression: an update that rewrites a task must not mint a second document,
    // lose its stable id/path, or drop Korean body text.
    const { store } = setup();
    const note = writeNote(
      store,
      "threads/notes/korean",
      "회의 준비",
      "내일 회의 안건을 정리한다.",
    );
    expect(note.path).toBe("threads/notes/korean.md");
    expect(note.kind).toBe("thread");
    expect(note.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(store.read(note.id)).toMatchObject({
      text: "내일 회의 안건을 정리한다.",
      path: note.path,
    });

    const task = store.write({
      path: "commitments/notes/report.md",
      kind: "commitment",
      title: "보고서",
      text: "초안 작성",
      source: { type: "agent" },
      status: "open",
      now: NOW,
    });
    const done = store.update({
      id: task.id,
      expectedHash: task.hash,
      text: "초안 제출",
      status: "done",
      now: NOW + 60_000,
    });
    expect(done).toMatchObject({
      id: task.id,
      path: task.path,
      status: "done",
      text: "초안 제출",
      createdAt: task.createdAt,
    });
    expect(done.updatedAt).not.toBe(task.updatedAt);
  });

  test("traversal refused and existing path conflict (regression: path escape or silent overwrite)", () => {
    // Regression: `..`/backslash/kind-root escapes must never become writes, and a
    // create must not silently replace a different revision at the same path.
    const { store } = setup();
    expect(() => writeNote(store, "../escape", "탈출", "본문")).toThrow(WhiteboardPathError);
    expect(() => writeNote(store, "records/../escape.md", "탈출", "본문")).toThrow(
      WhiteboardPathError,
    );
    expect(() => writeNote(store, "records/note.md", "탈출", "본문")).toThrow(WhiteboardPathError);

    const first = writeNote(store, "threads/notes/a.md", "하나", "본문 하나");
    const identical = writeNote(store, "threads/notes/a.md", "하나", "본문 하나");
    expect(identical.hash).toBe(first.hash);
    let code = "";
    try {
      writeNote(store, "threads/notes/a.md", "하나", "다른 본문");
    } catch (error) {
      code = error instanceof WhiteboardError ? error.code : "unexpected";
    }
    expect(code).toBe("path_exists");
  });

  test("stale hash refused with exact hashes (regression: clobbered concurrent edit)", () => {
    // Regression: a concurrent manual edit must fail closed instead of overwriting it.
    const { root, store } = setup();
    const note = writeNote(store, "threads/notes/stale.md", "노트", "원본");
    const absolute = resolve(root, note.path);
    writeFileSync(absolute, readFileSync(absolute, "utf8").replace("원본", "수정"), "utf8");
    let conflict: unknown;
    try {
      store.update({ id: note.id, expectedHash: note.hash, text: "덮어쓰기", now: NOW + 1 });
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(WhiteboardConflictError);
    if (!(conflict instanceof WhiteboardConflictError)) throw new Error("expected stale conflict");
    const typed = conflict;
    expect(typed.code).toBe("stale_hash");
    expect(typed.expectedHash).toBe(note.hash);
    expect(typed.actualHash).not.toBe(note.hash);
    expect(typed.actualHash).toMatch(/^[a-f0-9]{64}$/);
    const reread = store.read(note.id);
    expect(reread?.text).toBe("수정");
    expect(
      store.update({ id: note.id, expectedHash: typed.actualHash, text: "확정", now: NOW + 2 })
        .text,
    ).toBe("확정");
  });

  test("manual edit reindexes and 2-char Korean search matches (regression: stale index/missed Korean)", () => {
    // Regression: edits made outside the store must become searchable again, and
    // FTS5 unicode61 must match a two-syllable Korean word without matching a peer.
    const { root, store } = setup();
    const meeting = writeNote(store, "threads/notes/meeting.md", "주간 회의", "회의 안건");
    writeNote(store, "threads/notes/lunch.md", "점심", "메뉴 결정");
    expect(store.list({ query: "회의" }).map((row) => row.id)).toEqual([meeting.id]);

    const absolute = resolve(root, meeting.path);
    writeFileSync(absolute, readFileSync(absolute, "utf8").replace("회의 안건", "회의 안건 변경"));
    store.refresh();
    const reread = store.read(meeting.id);
    expect(reread?.text).toContain("변경");
    expect(reread?.hash).not.toBe(meeting.hash);
    expect(store.list({ query: "변경" }).map((row) => row.id)).toEqual([meeting.id]);
  });

  test("saveItems Gmail/Canvas project while disabled source is excluded (regression: adapter replay/source leak)", () => {
    // Regression: collection through the real seam must materialize without an
    // adapter replay, while a disabled source must not leak into the whiteboard.
    const { db, root, store } = setup();
    saveItems(
      db,
      DEFAULT_GOOGLE_ACCOUNT_ID,
      "gmail",
      [
        {
          id: "m1",
          source: "gmail",
          title: "회의 초대",
          at: "2026-11-27T01:00:00.000Z",
          detail: "메일 본문",
          url: "https://mail.example/m1",
        },
      ],
      NOW,
    );
    saveItems(
      db,
      DEFAULT_CANVAS_ACCOUNT_ID,
      "canvas",
      [
        {
          id: "a1",
          source: "canvas",
          title: "과제 제출",
          at: "2026-11-28T00:00:00.000Z",
          detail: "과제 설명",
          url: null,
        },
      ],
      NOW,
    );
    saveItems(
      db,
      DEFAULT_GOOGLE_ACCOUNT_ID,
      "calendar",
      [{ id: "c1", source: "calendar", title: "비활성 일정", at: null, detail: "", url: null }],
      NOW,
    );
    setSourceEnabled(db, DEFAULT_GOOGLE_ACCOUNT_ID, "calendar", false);
    store.refresh();

    const documents = store.list({ limit: 200 });
    const gmail = documents.find((row) => row.source["type"] === "gmail");
    const canvas = documents.find((row) => row.source["type"] === "canvas");
    // The 2026-11-28 layout: mail is the inbox, an LMS item sits under its own course and year.
    expect(gmail?.path).toMatch(
      /^records\/inbox\/\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}-.+-[a-z0-9]{6}\.md$/,
    );
    expect(gmail?.path).toContain("회의-초대");
    expect(gmail?.source["itemId"]).toBe("m1");
    // Without a course name in the item, the year/month folder is the honest place.
    expect(canvas?.path).toMatch(/^records\/courses\/\d{4}\/(\d{2}|.+)\/\d{4}-\d{2}-\d{2}-/);
    expect(documents.some((row) => row.source["type"] === "calendar")).toBe(false);
    const gmailDocument = store.read(gmail?.id ?? "");
    expect(gmailDocument?.text).toContain("메일 본문");
    expect(readFileSync(resolve(root, gmail?.path ?? ""), "utf8")).toStartWith("---\n");
    expect(store.read(canvas?.id ?? "")?.text).toContain("과제 설명");
  });

  test("an LMS item with a course is filed under that course", () => {
    const { db, store } = setup();
    saveItems(
      db,
      DEFAULT_CANVAS_ACCOUNT_ID,
      "canvas",
      [
        {
          id: "a2",
          source: "canvas",
          title: "중간 보고서",
          at: "2026-11-28T00:00:00.000Z",
          detail: "과목 소프트웨어공학 · 2페이지 분량",
          url: null,
        },
      ],
      NOW,
    );
    store.refresh();
    const document = store.list({ limit: 50 }).find((row) => row.source["itemId"] === "a2");
    expect(document?.path).toStartWith("records/courses/소프트웨어공학/2026/");
  });

  test("workflow/run/watch project current operational state (regression: lost run state or schedule)", () => {
    // Regression: operational tables stay authoritative, and their current
    // definition/state must be readable as deterministically named documents.
    const { db, root, store } = setup();
    const workflow = createWorkflow(
      db,
      { title: "일일 조사", instruction: "회의 자료를 조사한다", executor: { kind: "agent" } },
      NOW,
    );
    const binding = createBinding(
      db,
      {
        workflowId: workflow.id,
        trigger: { kind: "daily", time: "06:30", timeZone: "Asia/Seoul" },
      },
      NOW,
    );
    const run = enqueueRun(db, new EventLog(db), {
      goal: "일일 조사 실행",
      workflow: { id: workflow.id, title: workflow.title, params: {} },
      scheduleId: binding.id,
      triggerKind: "schedule",
      now: NOW,
    });
    store.refresh();
    const commitments = store.list({ kind: "commitment", limit: 200 });
    const watch = store
      .list({ kind: "watch", limit: 200 })
      .find((row) => row.source["type"] === "schedule" && row.source["scheduleId"] === binding.id);
    const workflowDocument = commitments.find(
      (row) => row.source["type"] === "workflow" && row.source["workflowId"] === workflow.id,
    );
    const runDocument = commitments.find(
      (row) => row.source["type"] === "run" && row.source["runId"] === run.id,
    );
    expect(runDocument?.source["runId"]).toBe(run.id);
    expect(runDocument?.title).toBe(workflow.title);
    expect(workflowDocument?.path).toStartWith("workspaces/");
    expect(runDocument?.path).toMatch(/^runs\/\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}-/);
    expect(runDocument?.status).toBe("queued");
    expect(watch?.path).toStartWith("schedules/");
    expect(watch?.status).toBe("enabled");
    expect(store.read(workflowDocument?.id ?? "")?.text).toContain("회의 자료를 조사한다");
    expect(store.read(runDocument?.id ?? "")?.text).toContain("일일 조사 실행");
    expect(readFileSync(resolve(root, watch?.path ?? ""), "utf8")).toContain("06:30");
  });
});
