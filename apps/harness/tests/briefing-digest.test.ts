import { Database } from "bun:sqlite";
import { ok } from "node:assert/strict";
import { test, expect } from "bun:test";
import { migrate } from "../src/store/db";
import { EventLog } from "../src/events/log";
import { createRegistry } from "../src/tools/registry";
import { BASE_POLICY } from "../src/core/policy";
import type { AdapterEvent, StreamFn } from "../src/providers/openai";
import {
  claimNext,
  enqueueRun,
  executeRun,
  getRun,
  type WorkDeps,
} from "../src/surfaces/work/runner";
import { BRIEFING_EXECUTOR } from "../src/workflows/system-workflows";

/**
 * Live 2026-11-27/28: a briefing run spent every round on whiteboard lists and died with
 * `tool_round_limit` before publishing. The fix is two-sided — the app hands the agent a
 * digest as its first message, and the instance may ask for a larger round budget — so this
 * proves both on the real runner with a scripted model that only ever publishes.
 */

type Captured = { messages: { role: string; content: string }[]; tools: string[] };

function recording(steps: AdapterEvent[][], captured: Captured[]): StreamFn {
  let index = 0;
  return async function* (messages, tools) {
    captured.push({
      messages: messages.map((message) => ({ role: message.role, content: message.content })),
      tools: tools.map((tool) => tool.name),
    });
    const step = steps[Math.min(index, steps.length - 1)] ?? [];
    index += 1;
    for (const event of step) yield event;
  };
}

function publishStep(sourceId: string): AdapterEvent[] {
  return [
    {
      type: "tool_call",
      id: "publish",
      name: "briefing_publish",
      arguments: JSON.stringify({ text: "오늘 새 소식은 없습니다.", sourceIds: [sourceId] }),
    },
    { type: "done", finishReason: "tool_calls" },
  ];
}

function harness(stream: StreamFn, rounds: number) {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  const events = new EventLog(db);
  const publish = {
    name: "briefing_publish",
    description: "stores the briefing",
    parameters: { type: "object" as const, properties: {} },
    // The production tool edits the owner's own board; an unattended run is not "ask".
    action: "read",
    execute: async (args: Record<string, unknown>) => {
      const text = typeof args["text"] === "string" ? args["text"] : "";
      db.query(
        "INSERT INTO briefings (id,slot,content_json,created_at,run_id) VALUES (?,?,?,?,NULL)",
      ).run(
        crypto.randomUUID(),
        "07:30",
        JSON.stringify({
          slot: "07:30",
          generatedAt: new Date().toISOString(),
          text,
          references: args["sourceIds"] ?? [],
        }),
        new Date().toISOString(),
      );
      return JSON.stringify({ stored: true });
    },
  };
  const deps: WorkDeps = {
    db,
    events,
    stream,
    tools: createRegistry([publish]),
    policy: BASE_POLICY,
    limits: {
      firstTokenMs: 5_000,
      idleMs: 5_000,
      toolMs: 2_000,
      maxOutputTokens: 200,
      maxToolRounds: rounds,
      totalMs: 30_000,
    },
  };
  return { db, events, deps };
}

test("a briefing run publishes from the digest without surveying the board", async () => {
  const captured: Captured[] = [];
  const run = harness(
    recording(
      [
        publishStep("wb_x"),
        [
          { type: "text_delta", text: "저장했습니다." },
          { type: "done", finishReason: "stop" },
        ],
      ],
      captured,
    ),
    16,
  );
  // Given a collected source the digest reports (the seeds already create the row), so the
  // digest has something to say and actually starts the run.
  run.db
    .query("UPDATE account_sources SET last_sync_at=?, ok=1 WHERE source='gmail'")
    .run(new Date().toISOString());
  run.db
    .query(
      "INSERT INTO sync_items (account_id,source,item_id,title,at,detail,url,updated_at) VALUES ('6f1c7a52-9b3e-4f8a-9c2d-71b0a5d4e8c6','gmail','m1','회의 초대장',?,'',NULL,?)",
    )
    .run(new Date().toISOString(), new Date().toISOString());
  const queued = enqueueRun(run.db, run.events, {
    goal: "브리핑",
    executor: { ...BRIEFING_EXECUTOR, maxToolRounds: 16 },
    workflow: { id: "system:briefing", title: "브리핑 생성", params: {} },
  });
  const claimed = claimNext(run.db, run.events, "w1");
  ok(claimed, "fixture worker claims the briefing run");
  expect(claimed.id).toBe(queued.id);
  const outcome = await executeRun(run.deps, claimed);
  // Then the run succeeds in two rounds: publish, then the spoken answer.
  expect(outcome).toBe("succeeded");
  expect(captured.length).toBe(2);
  // And the first request already carried the digest, so no survey was needed.
  const [first] = captured;
  ok(first, "the model was asked at least once");
  expect(first.messages.map((message) => message.role)).toEqual(["system", "user"]);
  expect(first.messages[1]?.content).toContain("지난 브리핑");
  expect(first.tools).toEqual(["briefing_publish"]);
  // The persona travelled with the instance rather than only the goal.
  expect(first.messages[0]?.content).toContain("브리핑 에이전트");
  expect(getRun(run.db, queued.id)?.status).toBe("succeeded");
});

test("an instance round budget above the runtime default is honoured", async () => {
  const captured: Captured[] = [];
  const steps: AdapterEvent[][] = [];
  // Four tool rounds would exceed a default of 3; the instance asks for 5.
  for (let index = 0; index < 4; index += 1)
    steps.push([
      { type: "tool_call", id: `c${index}`, name: "briefing_publish", arguments: "{}" },
      { type: "done", finishReason: "tool_calls" },
    ]);
  steps.push([
    { type: "text_delta", text: "끝" },
    { type: "done", finishReason: "stop" },
  ]);
  const run = harness(recording(steps, captured), 3);
  const queued = enqueueRun(run.db, run.events, {
    goal: "브리핑",
    executor: { kind: "agent", maxToolRounds: 5 },
  });
  const claimed = claimNext(run.db, run.events, "w1");
  ok(claimed, "fixture worker claims the run");
  const outcome = await executeRun(run.deps, claimed);
  expect(claimed.id).toBe(queued.id);
  expect(outcome).toBe("succeeded");
});
