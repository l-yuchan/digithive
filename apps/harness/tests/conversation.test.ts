import { ok } from "node:assert/strict";
import { describe, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { migrate } from "../src/store/db";
import { EventLog } from "../src/events/log";
import { appendEntry, createSession, listEntries, softDeleteSession } from "../src/core/sessions";
import { createRegistry } from "../src/tools/registry";
import { ProviderError, type AdapterEvent, type StreamFn } from "../src/providers/openai";
import { runTurn, type ConversationDeps } from "../src/surfaces/conversation/loop";

function setup(): { db: Database; events: EventLog; sessionId: string } {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  const session = createSession(db, "테스트");
  return { db, events: new EventLog(db), sessionId: session.id };
}

function deps(
  db: Database,
  events: EventLog,
  stream: StreamFn,
  extra: Partial<ConversationDeps> = {},
): ConversationDeps {
  return { db, events, stream, tools: createRegistry([]), ...extra };
}

function textStream(chunks: string[]): StreamFn {
  return async function* () {
    for (const text of chunks) yield { type: "text_delta", text };
    yield { type: "done", finishReason: "stop" };
  };
}

async function waitFor<T>(read: () => T | null, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not met in time");
}

describe("conversation turn", () => {
  test("provider failure persists a visible error part and run diagnostics", async () => {
    const { db, events, sessionId } = setup();
    const stream: StreamFn = async function* () {
      yield { type: "text_delta", text: "부분 응답" };
      throw new Error("HTTP 429: quota exhausted; reset in 31m");
    };
    const result = await runTurn(deps(db, events, stream), { sessionId, text: "실패 재현" });
    expect(result.status).toBe("failed");
    const assistant = listEntries(db, sessionId).find((entry) => entry.role === "assistant");
    // The routing failure is an event of its own, ahead of the partial answer.
    const kinds = assistant?.events.map((event) => event.type) ?? [];
    expect(kinds).toContain("error");
    expect(
      assistant?.events.some(
        (event) => event.type === "error" && event.detail.includes("quota exhausted"),
      ),
    ).toBe(true);
    expect(
      assistant?.events.some((event) => event.type === "text" && event.text === "부분 응답"),
    ).toBe(true);
    const row = db
      .query<{ result_json: string }, [string]>("SELECT result_json FROM runs WHERE id = ?")
      .get(result.runId);
    expect(row?.result_json).toContain("reset in 31m");
    db.close();
  });

  test("streams deltas into one assistant entry and settles the run", async () => {
    const { db, events, sessionId } = setup();
    const result = await runTurn(deps(db, events, textStream(["안", "녕", "하세요"])), {
      sessionId,
      text: "인사해줘",
    });
    expect(result.status).toBe("succeeded");
    expect(result.text).toBe("안녕하세요");

    const entries = listEntries(db, sessionId);
    const assistant = entries.find((entry) => entry.role === "assistant");
    expect(assistant?.status).toBe("complete");
    expect(assistant?.events).toEqual([{ type: "text", id: 0, text: "안녕하세요" }]);

    const kinds = events.after(0, sessionId).map((event) => event.kind);
    const order = ["turn.started", "text.delta", "turn.response.completed", "turn.done"];
    let cursor = -1;
    for (const kind of order) {
      const index = kinds.indexOf(kind, cursor + 1);
      expect(index).toBeGreaterThan(cursor);
      cursor = index;
    }
    expect(kinds.filter((kind) => kind === "text.delta").length).toBe(3);
    expect(kinds).not.toContain("turn.response.aborted");

    const run = db
      .query<{ status: string }, SQLQueryBindings[]>("SELECT status FROM runs WHERE id = ?")
      .get(result.runId);
    ok(run, "fixture row exists");
    expect(run.status).toBe("succeeded");
  });

  test("an answer is stored while it still streams, so a reconnect sees it", async () => {
    const { db, events, sessionId } = setup();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stream: StreamFn = async function* () {
      yield { type: "text_delta", text: "먼저 확인합니다. " };
      await gate;
      yield { type: "text_delta", text: "확인을 마쳤습니다." };
      yield { type: "done", finishReason: "stop" };
    };
    const running = runTurn(deps(db, events, stream), { sessionId, text: "진행 상황" });
    const partial = await waitFor(() => {
      const entry = listEntries(db, sessionId).find((candidate) => candidate.role === "assistant");
      return entry && entry.events.length > 0 ? entry : null;
    });
    expect(partial.status).toBe("streaming");
    expect(partial.events).toEqual([{ type: "text", id: 0, text: "먼저 확인합니다. " }]);
    release();
    const result = await running;
    expect(result.status).toBe("succeeded");
    const settled = listEntries(db, sessionId).find((entry) => entry.role === "assistant");
    expect(settled?.status).toBe("complete");
    expect(settled?.events).toEqual([
      { type: "text", id: 0, text: "먼저 확인합니다. 확인을 마쳤습니다." },
    ]);
    db.close();
  });

  test("a denied tool call becomes a tool_result the model sees, and the turn continues", async () => {
    const { db, events, sessionId } = setup();
    let call = 0;
    const stream: StreamFn = async function* () {
      call += 1;
      if (call === 1) {
        yield {
          type: "tool_call",
          id: "call_1",
          name: "shell_exec",
          arguments: '{"command":"rm -rf /"}',
        };
        yield { type: "done", finishReason: "tool_calls" };
        return;
      }
      yield { type: "text_delta", text: "거부되었습니다." };
      yield { type: "done", finishReason: "stop" };
    };
    const tools = createRegistry([
      {
        name: "shell_exec",
        description: "run a shell command",
        parameters: { type: "object", properties: { command: { type: "string" } } },
        action: "shell",
        execute: async () => "should not run",
      },
    ]);
    const result = await runTurn(
      deps(db, events, stream, {
        tools,
        policy: [{ action: "shell", resource: "*", effect: "deny" }],
      }),
      { sessionId, text: "삭제해줘" },
    );
    expect(result.status).toBe("succeeded");
    expect(result.text).toBe("거부되었습니다.");

    const assistant = listEntries(db, sessionId).find((entry) => entry.role === "assistant");
    const toolResult = assistant?.events.find((part) => part.type === "tool_result");
    expect(toolResult).toMatchObject({
      type: "tool_result",
      failed: true,
      name: "shell_exec",
      detail: "정책이 이 호출을 거부했습니다.",
    });
    // The call and its result are separate events answering the same call.
    expect(assistant?.events.filter((event) => event.type === "tool_call")).toHaveLength(1);
    expect(events.after(0, sessionId).map((event) => event.kind)).toContain("tool.denied");
  });

  test("a tool that never resolves is cut off by the tool deadline and the turn continues", async () => {
    const { db, events, sessionId } = setup();
    let call = 0;
    const stream: StreamFn = async function* () {
      call += 1;
      if (call === 1) {
        yield { type: "tool_call", id: "call_1", name: "slow", arguments: "{}" };
        yield { type: "done", finishReason: "tool_calls" };
        return;
      }
      yield { type: "text_delta", text: "도구가 멈춰서 중단했습니다." };
      yield { type: "done", finishReason: "stop" };
    };
    const tools = createRegistry([
      {
        name: "slow",
        description: "never ends",
        parameters: {},
        action: "read",
        execute: () => new Promise<string>(() => {}),
      },
    ]);
    const result = await runTurn(
      deps(db, events, stream, {
        tools,
        limits: {
          firstTokenMs: 5_000,
          idleMs: 5_000,
          totalMs: 5_000,
          toolMs: 30,
          maxOutputTokens: 100,
          maxToolRounds: 3,
        },
      }),
      {
        sessionId,
        text: "느린 도구 실행",
      },
    );
    expect(result.status).toBe("succeeded");
    expect(events.after(0, sessionId).map((event) => event.kind)).toContain("tool.timeout");
  });

  test("an aborted stream settles the run as interrupted instead of leaving it running", async () => {
    const { db, events, sessionId } = setup();
    const hanging: StreamFn = (_messages, _tools, options) => ({
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<AdapterEvent>>((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => reject(new ProviderError("aborted")), {
              once: true,
            });
          }),
      }),
    });
    const result = await runTurn(
      deps(db, events, hanging, {
        limits: {
          firstTokenMs: 5_000,
          idleMs: 5_000,
          totalMs: 40,
          toolMs: 1_000,
          maxOutputTokens: 100,
          maxToolRounds: 1,
        },
      }),
      { sessionId, text: "멈추는 요청" },
    );
    expect(result.status).toBe("aborted");
    const run = db
      .query<
        {
          status: string;
          cancel_intent: string | null;
          settled_at: string | null;
        },
        SQLQueryBindings[]
      >("SELECT status, cancel_intent, settled_at FROM runs WHERE id = ?")
      .get(result.runId);
    ok(run, "fixture row exists");
    expect(run.status).toBe("interrupted");
    expect(run.cancel_intent).toBe("timeout");
    expect(run.settled_at).not.toBeNull();
    const kinds = events.after(0, sessionId).map((event) => event.kind);
    expect(kinds).toContain("turn.response.aborted");
    expect(kinds).toContain("run.interrupted");
  });
});

describe("events are first class", () => {
  test("thinking, the tool call, its result and each paragraph are separate events in order", async () => {
    const { db, events, sessionId } = setup();
    let round = 0;
    const stream: StreamFn = async function* () {
      round += 1;
      if (round === 1) {
        // Two reasoning rounds split by a paragraph, then a tool call, then an answer.
        yield { type: "reasoning_delta", text: "먼저 " };
        yield { type: "reasoning_delta", text: "확인한다." };
        yield { type: "text_delta", text: "확인하겠습니다." };
        yield { type: "tool_call", id: "c1", name: "echo", arguments: '{"text":"hi"}' };
        yield { type: "done", finishReason: "tool_calls" };
        return;
      }
      yield { type: "text_delta", text: "완료했습니다." };
      yield { type: "done", finishReason: "stop" };
    };
    const tools = createRegistry([
      {
        name: "echo",
        description: "echo",
        parameters: { type: "object", properties: { text: { type: "string" } } },
        action: "read",
        execute: async (args) => (typeof args["text"] === "string" ? args["text"] : ""),
      },
    ]);
    const result = await runTurn(deps(db, events, stream, { tools }), {
      sessionId,
      text: "확인해줘",
    });
    expect(result.status).toBe("succeeded");

    const assistant = listEntries(db, sessionId).find((entry) => entry.role === "assistant");
    const turn = assistant?.events ?? [];
    expect(turn.map((event) => event.type)).toEqual([
      "thinking",
      "text",
      "tool_call",
      "tool_result",
      "text",
    ]);
    // The numbering is the position in the turn and never repeats.
    expect(turn.map((event) => event.id)).toEqual([0, 1, 2, 3, 4]);
    expect(turn[0]).toEqual({ type: "thinking", id: 0, text: "먼저 확인한다." });
    // The call and its result answer the same call id, and the paragraph after the
    // tool round is a new event rather than being glued to the first one.
    const call = turn[2];
    const answered = turn[3];
    expect(call?.type === "tool_call" && call.callId).toBe("c1");
    expect(answered?.type === "tool_result" && answered.callId).toBe("c1");
    expect(answered?.type === "tool_result" && answered.detail).toBe("hi");
    expect(turn[4]).toEqual({ type: "text", id: 4, text: "완료했습니다." });
    expect(result.text).toBe("확인하겠습니다.완료했습니다.");
  });

  test("the stored parts of an older record still read as events", () => {
    const { db, sessionId } = setup();
    const entry = appendEntry(db, {
      sessionId,
      kind: "message",
      role: "assistant",
      events: [],
    });
    db.query("UPDATE entries SET payload_json = ? WHERE id = ?").run(
      JSON.stringify({
        parts: [
          { type: "reasoning", text: "생각" },
          { type: "text", text: "답" },
          { type: "tool_call", id: "x", name: "t", arguments: "{}" },
          { type: "tool_result", id: "x", name: "t", output: "r", denied: true },
        ],
      }),
      entry.id,
    );
    const read = listEntries(db, sessionId).find((candidate) => candidate.id === entry.id);
    expect(read?.events).toEqual([
      { type: "thinking", id: 0, text: "생각" },
      { type: "text", id: 1, text: "답" },
      { type: "tool_call", id: 2, callId: "x", name: "t", detail: "{}" },
      { type: "tool_result", id: 3, callId: "x", name: "t", detail: "r", failed: true },
    ]);
    db.close();
  });
});

test("deleting a session during a stream prevents tool effects and preserves cancellation", async () => {
  const { db, events, sessionId } = setup();
  let effects = 0;
  const stream: StreamFn = async function* () {
    softDeleteSession(db, sessionId);
    yield { type: "tool_call", id: "late", name: "effect", arguments: "{}" };
    yield { type: "done", finishReason: "tool_calls" };
  };
  try {
    const tools = createRegistry([
      {
        name: "effect",
        description: "effect",
        parameters: {},
        action: "read",
        execute: async () => {
          effects++;
          return "late";
        },
      },
    ]);
    const result = await runTurn(deps(db, events, stream, { tools }), {
      sessionId,
      text: "cancel me",
    });
    expect(result.status).toBe("aborted");
    expect(effects).toBe(0);
    expect(db.query("SELECT status,cancel_intent FROM runs").get()).toEqual({
      status: "cancelled",
      cancel_intent: "policy",
    });
  } finally {
    db.close();
  }
});
