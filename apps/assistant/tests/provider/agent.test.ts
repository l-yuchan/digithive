import assert from "node:assert/strict";
import { afterEach, test } from "bun:test";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { migrate, migrations } from "../../src/db/store";
import { enqueue } from "../../src/runtime/queue";
import { runAgent } from "../../src/runtime/executors/agent";
import { createRegistry, type ToolDefinition } from "../../src/agents/tools";
import { buildContext, validCitations, conversationMessages } from "../../src/agents/context";
import { billedMicroUsd, estimateMicroUsd, type Pricing } from "../../src/agents/provider";

const databases: Database[] = [];
const servers: { stop(force?: boolean): void }[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const server of servers.splice(0)) server.stop(true);
});

const pricing: Pricing = { version: "fixture-v1", inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 2 };

function database(): Database {
  const db = new Database(":memory:", { strict: true });
  migrate(db, migrations());
  databases.push(db);
  return db;
}

function fixture(script: unknown[]): string {
  const server = Bun.serve({
    port: 0,
    async fetch() {
      const body = script.shift() ?? { choices: [{ message: { role: "assistant", content: "" } }] };
      return Response.json(body);
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

const notesTool = (seen: string[]): ToolDefinition => ({
  name: "read_note",
  description: "Read one stored note",
  parameters: z.object({ id: z.string().min(1) }).strict(),
  scope: "note.read",
  execute: async (args) => {
    seen.push(String(args["id"]));
    return "note body";
  },
});

test("a tool call is validated, executed once and its result reaches the final answer", async () => {
  const db = database();
  const run = enqueue(db, { requestKey: "agent-1", goal: "read my note", executor: "agent" });
  const seen: string[] = [];
  const baseUrl = fixture([
    {
      choices: [{
        message: {
          role: "assistant", content: null,
          tool_calls: [{ id: "call-1", name: "read_note", arguments: '{"id":"n1"}' }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    },
    {
      choices: [{ message: { role: "assistant", content: "The note says: note body" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 120, completion_tokens: 20 },
    },
  ]);
  const outcome = await runAgent(db, { baseUrl, model: "fixture", apiKey: "k", pricing },
    createRegistry([notesTool(seen)]), {
      runId: run.id, goal: "read my note", scopes: ["note.read"],
      limitMicroUsd: 100_000_000, timeZone: "Asia/Seoul",
    }, () => 1_700_000_000_000);

  assert.equal(outcome.status, "succeeded");
  assert.equal(outcome.output, "The note says: note body");
  assert.deepEqual(seen, ["n1"]);
  assert.deepEqual(outcome.toolCalls, [{ name: "read_note", ok: true }]);
  assert.equal(outcome.steps, 2);
  const settled = z.object({ total: z.number(), count: z.number() }).parse(db.query(
    "SELECT coalesce(sum(settled_micro_usd),0) AS total, count(*) AS count FROM cost_reservations WHERE status='settled'",
  ).get());
  assert.equal(settled.count, 2);
  assert.equal(settled.total, billedMicroUsd({
    choices: [{ message: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 10 },
  }, pricing)! + billedMicroUsd({
    choices: [{ message: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 120, completion_tokens: 20 },
  }, pricing)!);
});

test("unknown tools, bad arguments and missing scopes never execute a handler", async () => {
  const db = database();
  const run = enqueue(db, { requestKey: "agent-2", goal: "try everything", executor: "agent" });
  const executed: string[] = [];
  const baseUrl = fixture([
    {
      choices: [{
        message: {
          role: "assistant", content: null,
          tool_calls: [
            { id: "c1", name: "delete_everything", arguments: "{}" },
            { id: "c2", name: "read_note", arguments: '{"id":' },
            { id: "c3", name: "read_note", arguments: '{"id":"n1","extra":true}' },
          ],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 50, completion_tokens: 5 },
    },
    { choices: [{ message: { role: "assistant", content: "I could not do that." }, finish_reason: "stop" }] },
  ]);
  const outcome = await runAgent(db, { baseUrl, model: "fixture", apiKey: "k", pricing },
    createRegistry([notesTool(executed)]), {
      runId: run.id, goal: "try everything", scopes: [],
      limitMicroUsd: 100_000_000, timeZone: "Asia/Seoul",
    }, () => 1_700_000_000_000);

  assert.equal(outcome.status, "succeeded");
  assert.deepEqual(executed, []);
  assert.deepEqual(outcome.toolCalls.map((call) => call.ok), [false, false, false]);
});

test("a truncated response keeps the charge unknown and fails the run", async () => {
  const db = database();
  const run = enqueue(db, { requestKey: "agent-3", goal: "long answer", executor: "agent" });
  const baseUrl = fixture([
    { choices: [{ message: { role: "assistant", content: "partial" }, finish_reason: "length" }], usage: undefined },
  ]);
  const outcome = await runAgent(db, { baseUrl, model: "fixture", apiKey: "k", pricing },
    createRegistry([notesTool([])]), {
      runId: run.id, goal: "long answer", scopes: [],
      limitMicroUsd: 100_000_000, timeZone: "Asia/Seoul",
    }, () => 1_700_000_000_000);

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.reason, "truncated");
  assert.deepEqual(db.query("SELECT status FROM cost_reservations").all(), [{ status: "unknown" }]);
  assert.equal(z.object({ count: z.number() }).parse(db.query("SELECT count(*) AS count FROM tool_calls").get()).count, 0);});

test("a disconnected provider is a failure, not an empty success", async () => {
  const db = database();
  const run = enqueue(db, { requestKey: "agent-4", goal: "anything", executor: "agent" });
  const outcome = await runAgent(db, { baseUrl: "http://127.0.0.1:1", model: "fixture", apiKey: "k", pricing },
    createRegistry([notesTool([])]), {
      runId: run.id, goal: "anything", scopes: [],
      limitMicroUsd: 100_000_000, timeZone: "Asia/Seoul",
    }, () => 1_700_000_000_000);

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.output, "");
  assert.equal(z.object({ count: z.number() }).parse(db.query("SELECT count(*) AS count FROM cost_reservations WHERE status='unknown'").get()).count, 1);
});

test("context bounds size and citations must name a provided source", () => {
  const sources = [
    { kind: "memory" as const, id: "m1", text: "user prefers short answers" },
    { kind: "file" as const, id: "f1", text: "x".repeat(500) },
  ];
  const built = buildContext({ systemPrompt: "Be brief.", sources, maxChars: 120 });
  assert.equal(built.usedSources.length, 1);
  assert.match(built.system, /\[memory:m1\]/);
  assert.deepEqual(
    validCitations([{ sourceId: "m1", quote: "short answers" }, { sourceId: "f1", quote: "invented" }], built.usedSources),
    [{ sourceId: "m1", quote: "short answers" }],
  );
  assert.deepEqual(conversationMessages([
    { role: "user", content: "hi" }, { role: "tool", content: "ignored" }, { role: "assistant", content: "hello" },
  ]), [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }]);
});

test("the reservation estimate scales with prompt size and output cap", () => {
  assert.equal(estimateMicroUsd(300, 100, pricing), 100 * 1 + 100 * 2);
  assert.equal(estimateMicroUsd(0, 0, pricing), 0);
});
