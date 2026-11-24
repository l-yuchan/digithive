import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase } from "../store/db";
import { EventLog } from "../events/log";
import { createRegistry } from "../tools/registry";
import { openAiStream } from "../providers/openai";
import { settleExpiredRuns } from "../core/run-state";
import { runTurn } from "../surfaces/conversation/loop";
import { createApp, type AppDeps } from "./app";

const here = import.meta.dir;
const appRoot = resolve(here, "../..");

export type HarnessConfig = {
  readonly port: number;
  readonly dbPath: string;
  readonly webRoot: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly maxChars: number;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): HarnessConfig {
  const dataDir = resolve(appRoot, "data");
  return {
    port: Number(env["PORT"] ?? "8799"),
    dbPath: env["HARNESS_DB"] ?? resolve(dataDir, "harness.db"),
    webRoot: resolve(appRoot, "web/dist"),
    baseUrl: env["MODEL_BASE_URL"] ?? "http://127.0.0.1:8798/v1",
    apiKey: env["MODEL_API_KEY"] ?? "local",
    model: env["MODEL_NAME"] ?? "mock-model",
    maxChars: Number(env["HARNESS_MAX_CHARS"] ?? "24000"),
  };
}

export function createHarness(config: HarnessConfig): { deps: AppDeps; handler: (request: Request) => Promise<Response>; close: () => void } {
  if (config.dbPath !== ":memory:") mkdirSync(resolve(config.dbPath, ".."), { recursive: true });
  const db = openDatabase(config.dbPath);
  const events = new EventLog(db);
  const tools = createRegistry([]);
  const stream = openAiStream({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model });
  const summarize = async (transcript: string): Promise<string> => {
    let summary = "";
    for await (const event of stream(
      [
        { role: "system", content: "다음 대화를 나중에 맥락으로 쓸 수 있게 3~6문장으로 요약하세요. 사실만 남기고 추측은 넣지 마세요." },
        { role: "user", content: transcript },
      ],
      [],
      { maxOutputTokens: 512, firstTokenTimeoutMs: 30_000, idleTimeoutMs: 60_000 },
    )) {
      if (event.type === "text_delta") summary += event.text;
    }
    return summary;
  };
  const conversation = { db, events, stream, tools, summarize, maxChars: config.maxChars };
  const deps: AppDeps = { db, events, conversation, webRoot: config.webRoot };
  return { deps, handler: createApp(deps), close: () => db.close() };
}

if (import.meta.main) {
  const config = loadConfig();
  const harness = createHarness(config);
  const reconciled = settleExpiredRuns(harness.deps.db);
  if (reconciled.length > 0) {
    for (const runId of reconciled) {
      harness.deps.events.append({ kind: "run.interrupted", runId, payload: { reason: "host_restart" } });
    }
  }
  setInterval(() => {
    for (const runId of settleExpiredRuns(harness.deps.db)) {
      harness.deps.events.append({ kind: "run.interrupted", runId, payload: { reason: "lease_expired" } });
    }
  }, 15_000).unref();
  const server = Bun.serve({ port: config.port, fetch: harness.handler });
  console.log(`digithive harness on http://127.0.0.1:${server.port} (model ${config.model} @ ${config.baseUrl})`);
  void runTurn;
}
