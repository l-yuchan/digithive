import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { openDatabase } from "../src/db/store";
import { claim, complete, recoverExpired, start } from "../src/runtime/attempts";
import { runAgent } from "../src/runtime/executors/agent";
import { createRegistry } from "../src/agents/tools";
import { appendAssistant } from "../src/server/routes/conversations";
import { readSettings } from "../src/server/routes/settings";
import type { ProviderOptions } from "../src/agents/provider";

const db = openDatabase(resolve(process.env["ASSISTANT_DB_PATH"] ?? "./data/assistant.sqlite"));
const workerId = randomUUID();
const once = process.argv.includes("--once");

function providerOptions(): ProviderOptions | undefined {
  const baseUrl = process.env["MODEL_BASE_URL"];
  const model = process.env["MODEL_NAME"];
  const apiKey = process.env["MODEL_API_KEY"];
  const priceVersion = process.env["MODEL_PRICE_VERSION"];
  const input = Number(process.env["MODEL_INPUT_MICRO_USD_PER_TOKEN"] ?? "0");
  const output = Number(process.env["MODEL_OUTPUT_MICRO_USD_PER_TOKEN"] ?? "0");
  if (!baseUrl || !model || !apiKey || !priceVersion) return undefined;
  return {
    baseUrl, model, apiKey,
    pricing: { version: priceVersion, inputMicroUsdPerToken: input, outputMicroUsdPerToken: output },
  };
}

async function executeSha256(goal: string): Promise<{ status: "succeeded"; output: string }> {
  return { status: "succeeded", output: createHash("sha256").update(goal).digest("hex") };
}

async function executeAgent(attemptId: string, runId: string, goal: string): Promise<{ status: "succeeded" | "failed"; output: string }> {
  const provider = providerOptions();
  if (!provider) return { status: "failed", output: "model_unavailable" };
  const settings = readSettings(db);
  const outcome = await runAgent(db, provider, createRegistry([]), {
    runId,
    goal,
    scopes: ["note.read"],
    limitMicroUsd: settings.monthlyLimitMicroUsd,
    timeZone: settings.timezone,
    maxSteps: Number(process.env["AGENT_MAX_STEPS"] ?? "6"),
    maxOutputTokens: Number(process.env["AGENT_MAX_OUTPUT_TOKENS"] ?? "1024"),
    timeoutMs: Number(process.env["AGENT_TIMEOUT_MS"] ?? "60000"),
  });
  const conversation = db.query("SELECT conversation_id FROM runs WHERE id = ?").get(runId);
  const conversationId = z.object({ conversation_id: z.string().nullable() }).parse(conversation).conversation_id;
  if (outcome.status === "succeeded" && conversationId) {
    appendAssistant(db, conversationId, runId, outcome.output);
  }
  if (outcome.status === "cancelled") {
    return { status: "failed", output: "cancelled during execution" };
  }
  return { status: outcome.status, output: outcome.output || outcome.reason || "" };
}

try {
  do {
    recoverExpired(db);
    const attempt = claim(db, workerId);
    if (attempt) {
      if (!start(db, attempt, workerId)) continue;
      const result = attempt.executor_kind === "sha256"
        ? await executeSha256(attempt.goal)
        : attempt.executor_kind === "agent"
          ? await executeAgent(attempt.id, attempt.run_id, attempt.goal)
          : { status: "failed" as const, output: "Executor not registered" };
      complete(db, attempt, workerId, result);
    } else if (!once) {
      await Bun.sleep(1_000);
    }
  } while (!once);
} finally {
  db.close();
}
