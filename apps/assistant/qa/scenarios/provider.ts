import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { createRegistry, type ToolDefinition } from "../../src/agents/tools";
import { billedMicroUsd, type Pricing } from "../../src/agents/provider";
import { enqueue, getRun } from "../../src/runtime/queue";
import { runAgent } from "../../src/runtime/executors/agent";

type ProviderContext = {
  readonly db: Database;
  readonly evidence: string;
};

type Step = { status?: number; body: unknown; delayMs?: number };

let script: Step[] = [];
const transcript: { request: unknown; response: unknown }[] = [];

export function setProviderScript(steps: readonly Step[]): void {
  script = [...steps];
  transcript.splice(0);
}

export async function providerFetch(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path !== "/v1/chat/completions") return Response.json({ error: "not_found" }, { status: 404 });
  const body: unknown = await request.json();
  const step = script.shift() ?? { body: { choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }] } };
  if (step.delayMs) await Bun.sleep(step.delayMs);
  transcript.push({ request: body, response: step.body });
  return Response.json(step.body, { status: step.status ?? 200 });
}

const pricing: Pricing = { version: "fixture-v1", inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 2 };

const noteTool = (reads: string[]): ToolDefinition => ({
  name: "read_note",
  description: "Read one internal note by id",
  parameters: z.object({ id: z.string().min(1) }).strict(),
  scope: "note.read",
  execute: async (args) => {
    reads.push(String(args["id"]));
    return "release notes: sandbox runner verified";
  },
});

const providerOptions = { baseUrl: "http://127.0.0.1:4318/v1", model: "fixture-model", apiKey: "fixture-key", pricing };

export async function agentToolRoundtrip(context: ProviderContext): Promise<void> {
  setProviderScript([
    {
      body: {
        choices: [{
          message: {
            role: "assistant", content: null,
            tool_calls: [{ id: "call-1", name: "read_note", arguments: '{"id":"release-notes"}' }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 200, completion_tokens: 20 },
      },
    },
    {
      body: {
        choices: [{
          message: { role: "assistant", content: "The release notes say the sandbox runner was verified." },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 260, completion_tokens: 30 },
      },
    },
  ]);
  const run = enqueue(context.db, { requestKey: "agent-roundtrip", goal: "what do the release notes say?", executor: "agent" });
  const reads: string[] = [];
  const outcome = await runAgent(context.db, providerOptions, createRegistry([noteTool(reads)]), {
    runId: run.id,
    goal: "what do the release notes say?",
    scopes: ["note.read"],
    limitMicroUsd: 100_000_000,
    timeZone: "Asia/Seoul",
  });

  assert.equal(outcome.status, "succeeded");
  assert.deepEqual(reads, ["release-notes"]);
  assert.match(outcome.output, /sandbox runner was verified/);
  const reservations = z.array(z.object({ status: z.string(), settled_micro_usd: z.number().nullable() }))
    .parse(context.db.query("SELECT status, settled_micro_usd FROM cost_reservations ORDER BY created_at").all());
  assert.deepEqual(reservations.map((row) => row.status), ["settled", "settled"]);
  const expected = billedMicroUsd({ choices: [{ message: {}, finish_reason: "stop" }], usage: { prompt_tokens: 200, completion_tokens: 20 } }, pricing);
  assert.equal(reservations[0]?.settled_micro_usd, expected);
  assert.equal(getRun(context.db, run.id).status, "queued");

  await writeFile(join(context.evidence, "provider-http.json"), `${JSON.stringify({
    requests: transcript.map((entry) => entry.request), toolCallCount: transcript.length,
    modelCalls: 2, noteReads: reads, paidReservations: reservations,
  }, null, 2)}\n`);
  await writeFile(join(context.evidence, "run.json"), `${JSON.stringify({
    status: outcome.status, steps: outcome.steps, toolCalls: outcome.toolCalls, output: outcome.output,
  }, null, 2)}\n`);
}

export async function agentMalformedAndDisconnect(context: ProviderContext): Promise<void> {
  setProviderScript([
    {
      body: {
        choices: [{
          message: {
            role: "assistant", content: null,
            tool_calls: [
              { id: "bad-1", name: "delete_everything", arguments: "{}" },
              { id: "bad-2", name: "read_note", arguments: '{"id":' },
              { id: "bad-3", name: "read_note", arguments: '{"id":"ok","rm":"-rf"}' },
            ],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 90, completion_tokens: 9 },
      },
    },
    { body: { choices: [{ message: { role: "assistant", content: "I could not run those." }, finish_reason: "stop" }] } },
  ]);
  const run = enqueue(context.db, { requestKey: "agent-malformed", goal: "try everything", executor: "agent" });
  const reads: string[] = [];
  const outcome = await runAgent(context.db, providerOptions, createRegistry([noteTool(reads)]), {
    runId: run.id, goal: "try everything", scopes: ["note.read"],
    limitMicroUsd: 100_000_000, timeZone: "Asia/Seoul",
  });
  assert.equal(outcome.status, "succeeded");
  assert.deepEqual(reads, []);
  assert.deepEqual(outcome.toolCalls.map((call) => call.ok), [false, false, false]);

  setProviderScript([{ body: { choices: [{ message: { role: "assistant", content: "cut" }, finish_reason: "length" }] } }]);
  const truncatedRun = enqueue(context.db, { requestKey: "agent-truncated", goal: "long", executor: "agent" });
  const truncated = await runAgent(context.db, providerOptions, createRegistry([noteTool(reads)]), {
    runId: truncatedRun.id, goal: "long", scopes: ["note.read"], limitMicroUsd: 100_000_000, timeZone: "Asia/Seoul",
  });
  assert.equal(truncated.status, "failed");
  assert.equal(truncated.reason, "truncated");

  const unknown = z.array(z.object({ run_id: z.string(), status: z.string() })).parse(
    context.db.query("SELECT run_id, status FROM cost_reservations WHERE status = 'unknown' AND run_id = ?")
      .all(truncatedRun.id),
  );
  assert.equal(unknown.length, 1);
  assert.deepEqual(reads, []);
  assert.equal(z.object({ count: z.number() }).parse(
    context.db.query("SELECT count(*) AS count FROM tool_calls").get(),
  ).count, 0);

  await writeFile(join(context.evidence, "failures.json"), `${JSON.stringify({
    malformedToolCalls: outcome.toolCalls,
    handlersExecuted: reads.length,
    truncated: { status: truncated.status, reason: truncated.reason },
    unknownCharges: unknown.length,
    toolCallsPersisted: 0,
  }, null, 2)}\n`);
}
