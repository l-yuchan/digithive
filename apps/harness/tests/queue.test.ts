import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../src/store/db";
import { EventLog } from "../src/events/log";
import { createSession, listEntries } from "../src/core/sessions";
import { listQueue, setQueuePaused } from "../src/core/queue";
import { createRegistry } from "../src/tools/registry";
import { createConversation } from "../src/surfaces/conversation/surface";
import type { ConversationDeps } from "../src/surfaces/conversation/loop";

/**
 * The queue is the one piece whose behaviour lives in more than one place: the
 * surface decides whether a message runs now, the turn's settle hook decides what
 * runs next, and the app decides whether a name is chosen first. These tests drive
 * the real turn loop with a scripted stream, so each decision is observed through
 * the transcript and the queue table rather than through its own return value.
 */

const opened: (() => void)[] = [];
afterEach(() => {
  for (const close of opened.splice(0)) close();
});

function setup(options: { failNext?: boolean; startTitle?: () => boolean; gate?: Promise<void> }) {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  const events = new EventLog(db);
  let fail = options.failNext === true;
  const replied: string[] = [];
  const turnDeps = (): ConversationDeps => ({
    db,
    events,
    tools: createRegistry([]),
    stream: async function* (messages) {
      if (options.gate) await options.gate;
      if (fail) {
        fail = false;
        throw new Error("provider refused");
      }
      const last = messages.findLast((message) => message.role === "user")?.content ?? "";
      replied.push(last);
      yield { type: "text_delta", text: `답: ${last}` };
    },
  });
  const conversation = createConversation({
    db,
    events,
    turnDeps,
    // The naming run is the app's; in this test it ends only when the test says so.
    titleGuardMs: 60_000,
    ...(options.startTitle === undefined
      ? {}
      : { startTitle: () => options.startTitle?.() ?? false }),
  });
  opened.push(() => {
    conversation.close();
    db.close();
  });
  return { db, events, conversation, replied };
}

async function until(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for the queue");
    await Bun.sleep(10);
  }
}

/** Waits until every assistant turn has finished, i.e. the last one carries its answer. */
async function settled(db: Database, sessionId: string, turns: number): Promise<void> {
  await until(() => {
    const lines = transcript(db, sessionId);
    return lines.length === turns * 2 && lines.at(-1)?.includes("답:") === true;
  });
}

function transcript(db: Database, sessionId: string): string[] {
  return listEntries(db, sessionId)
    .filter((entry) => entry.kind === "message")
    .map(
      (entry) =>
        `${entry.role}:` +
        entry.events
          .filter((event) => event.type === "text")
          .map((event) => (event.type === "text" ? event.text : ""))
          .join(""),
    );
}

describe("a message typed while an answer is arriving", () => {
  test("waits, then runs in the order it was typed", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { db, conversation } = setup({ gate });
    const session = createSession(db, "큐");
    const first = conversation.send(session.id, "첫 질문");
    expect(first.queued).toBe(false);
    // The turn has not answered yet, so these two must not start.
    expect(conversation.send(session.id, "둘째 질문").queued).toBe(true);
    expect(conversation.send(session.id, "셋째 질문").queued).toBe(true);
    expect(listQueue(db, session.id).map((item) => item.text)).toEqual(["둘째 질문", "셋째 질문"]);
    open();
    await settled(db, session.id, 3);
    expect(transcript(db, session.id)).toEqual([
      "user:첫 질문",
      "assistant:답: 첫 질문",
      "user:둘째 질문",
      "assistant:답: 둘째 질문",
      "user:셋째 질문",
      "assistant:답: 셋째 질문",
    ]);
  });

  test("a queued message can be cancelled before it runs", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { db, conversation } = setup({ gate });
    const session = createSession(db, "취소");
    conversation.send(session.id, "첫 질문");
    conversation.send(session.id, "지울 질문");
    const queued = listQueue(db, session.id)[0];
    expect(queued).toBeDefined();
    expect(conversation.cancelQueued(session.id, queued?.id ?? "")).toBe(true);
    expect(conversation.cancelQueued(session.id, queued?.id ?? "")).toBe(false);
    open();
    await until(() => transcript(db, session.id).length === 2);
    await Bun.sleep(50);
    expect(transcript(db, session.id)).toEqual(["user:첫 질문", "assistant:답: 첫 질문"]);
  });
});

describe("a failed turn", () => {
  test("pauses the queue instead of meeting the same failure again, and resume drains it", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { db, conversation } = setup({ failNext: true, gate });
    const session = createSession(db, "실패");
    conversation.send(session.id, "첫 질문");
    conversation.send(session.id, "다음 질문");
    open();
    await until(() => conversation.queue(session.id).paused);
    expect(listQueue(db, session.id).map((item) => item.text)).toEqual(["다음 질문"]);
    const resumed = conversation.resume(session.id);
    expect(resumed.drained).toBe(true);
    // The turn then has to finish, not merely leave the queue.
    await settled(db, session.id, 2);
    expect(transcript(db, session.id).at(-1)).toBe("assistant:답: 다음 질문");
    expect(listQueue(db, session.id)).toEqual([]);
  });

  test("a paused session does not start a message that arrives later", async () => {
    const { db, conversation } = setup({});
    const session = createSession(db, "멈춤");
    setQueuePaused(db, session.id, true);
    // A paused queue holds the message; nothing starts behind the owner's back.
    conversation.send(session.id, "새 질문");
    await Bun.sleep(50);
    expect(listQueue(db, session.id).map((item) => item.text)).toEqual(["새 질문"]);
    conversation.resume(session.id);
    await until(() => listQueue(db, session.id).length === 0);
  });
});

describe("naming the first answer", () => {
  test("the name is chosen before the next queued question runs", async () => {
    const order: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { db, events, conversation } = setup({
      gate,
      startTitle: () => {
        order.push("title");
        return true;
      },
    });
    const session = createSession(db, "이름");
    conversation.send(session.id, "첫 질문");
    conversation.send(session.id, "둘째 질문");
    open();
    // The first answer is named; the queued question waits until that run reports it ended.
    await until(() => order.length === 1);
    expect(listQueue(db, session.id).map((item) => item.text)).toEqual(["둘째 질문"]);
    events.append({
      kind: "session.title_settled",
      sessionId: session.id,
      payload: { status: "succeeded" },
    });
    await settled(db, session.id, 2);
    expect(order).toEqual(["title"]);
    expect(transcript(db, session.id)).toEqual([
      "user:첫 질문",
      "assistant:답: 첫 질문",
      "user:둘째 질문",
      "assistant:답: 둘째 질문",
    ]);
  });

  test("a session that already has a name is not named again", () => {
    const { db, conversation } = setup({ startTitle: () => true });
    const session = createSession(db, "이름 있음");
    db.query("UPDATE sessions SET title_source='user' WHERE id=?").run(session.id);
    conversation.send(session.id, "질문");
    // shouldName refuses any title the owner or the app already wrote.
    expect(conversation.queue(session.id).items).toEqual([]);
  });
});
