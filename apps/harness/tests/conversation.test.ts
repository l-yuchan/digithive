import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../src/store/db";
import { EventLog } from "../src/events/log";
import { createSession, listEntries } from "../src/core/sessions";
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

function deps(db: Database, events: EventLog, stream: StreamFn, extra: Partial<ConversationDeps> = {}): ConversationDeps {
  return { db, events, stream, tools: createRegistry([]), ...extra };
}

function textStream(chunks: string[]): StreamFn {
  return async function* () {
    for (const text of chunks) yield { type: "text_delta", text } as AdapterEvent;
    yield { type: "done", finishReason: "stop" } as AdapterEvent;
  };
}

describe("conversation turn", () => {
  test("streams deltas into one assistant entry and settles the run", async () => {
    const { db, events, sessionId } = setup();
    const result = await runTurn(deps(db, events, textStream(["안", "녕", "하세요"])), { sessionId, text: "인사해줘" });
    expect(result.status).toBe("succeeded");
    expect(result.text).toBe("안녕하세요");

    const entries = listEntries(db, sessionId);
    const assistant = entries.find((entry) => entry.role === "assistant");
    expect(assistant?.status).toBe("complete");
    expect(assistant?.parts).toEqual([{ type: "text", text: "안녕하세요" }]);

    const kinds = events.after(0, sessionId).map((event) => event.kind);
    const order = ["turn.started", "message.delta", "message.completed", "turn.settled"];
    let cursor = -1;
    for (const kind of order) {
      const index = kinds.indexOf(kind, cursor + 1);
      expect(index).toBeGreaterThan(cursor);
      cursor = index;
    }
    expect(kinds.filter((kind) => kind === "message.delta").length).toBe(3);

    const run = db.query("SELECT status FROM runs WHERE id = ?").get(result.runId) as { status: string };
    expect(run.status).toBe("succeeded");
  });

  test("a denied tool call becomes a tool_result the model sees, and the turn continues", async () => {
    const { db, events, sessionId } = setup();
    let call = 0;
    const stream: StreamFn = async function* () {
      call += 1;
      if (call === 1) {
        yield { type: "tool_call", id: "call_1", name: "shell_exec", arguments: '{"command":"rm -rf /"}' } as AdapterEvent;
        yield { type: "done", finishReason: "tool_calls" } as AdapterEvent;
        return;
      }
      yield { type: "text_delta", text: "거부되었습니다." } as AdapterEvent;
      yield { type: "done", finishReason: "stop" } as AdapterEvent;
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
      deps(db, events, stream, { tools, policy: [{ action: "shell", resource: "*", effect: "deny" }] }),
      { sessionId, text: "삭제해줘" },
    );
    expect(result.status).toBe("succeeded");
    expect(result.text).toBe("거부되었습니다.");

    const assistant = listEntries(db, sessionId).find((entry) => entry.role === "assistant");
    const toolResult = assistant?.parts.find((part) => part.type === "tool_result");
    expect(toolResult).toMatchObject({ type: "tool_result", denied: true, name: "shell_exec" });
    expect(events.after(0, sessionId).map((event) => event.kind)).toContain("tool.denied");
  });

  test("a tool that never resolves is cut off by the tool deadline and the turn continues", async () => {
    const { db, events, sessionId } = setup();
    let call = 0;
    const stream: StreamFn = async function* () {
      call += 1;
      if (call === 1) {
        yield { type: "tool_call", id: "call_1", name: "slow", arguments: "{}" } as AdapterEvent;
        yield { type: "done", finishReason: "tool_calls" } as AdapterEvent;
        return;
      }
      yield { type: "text_delta", text: "도구가 멈춰서 중단했습니다." } as AdapterEvent;
      yield { type: "done", finishReason: "stop" } as AdapterEvent;
    };
    const tools = createRegistry([
      { name: "slow", description: "never ends", parameters: {}, action: "read", execute: () => new Promise<string>(() => {}) },
    ]);
    const result = await runTurn(deps(db, events, stream, { tools, limits: { firstTokenMs: 5_000, idleMs: 5_000, totalMs: 5_000, toolMs: 30, maxOutputTokens: 100, maxToolRounds: 3 } }), {
      sessionId,
      text: "느린 도구 실행",
    });
    expect(result.status).toBe("succeeded");
    expect(events.after(0, sessionId).map((event) => event.kind)).toContain("tool.timeout");
  });

  test("an aborted stream settles the run as interrupted instead of leaving it running", async () => {
    const { db, events, sessionId } = setup();
    const hanging: StreamFn = async function* (_messages, _tools, options) {
      await new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new ProviderError("aborted")), { once: true });
      });
    };
    const result = await runTurn(
      deps(db, events, hanging, { limits: { firstTokenMs: 5_000, idleMs: 5_000, totalMs: 40, toolMs: 1_000, maxOutputTokens: 100, maxToolRounds: 1 } }),
      { sessionId, text: "멈추는 요청" },
    );
    expect(result.status).toBe("aborted");
    const run = db.query("SELECT status, cancel_intent, settled_at FROM runs WHERE id = ?").get(result.runId) as {
      status: string;
      cancel_intent: string | null;
      settled_at: string | null;
    };
    expect(run.status).toBe("interrupted");
    expect(run.cancel_intent).toBe("timeout");
    expect(run.settled_at).not.toBeNull();
    const kinds = events.after(0, sessionId).map((event) => event.kind);
    expect(kinds).toContain("message.aborted");
    expect(kinds).toContain("run.interrupted");
  });
});
