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
  };
}

export function createHarness(config: HarnessConfig): { deps: AppDeps; handler: (request: Request) => Promise<Response>; close: () => void } {
  if (config.dbPath !== ":memory:") mkdirSync(resolve(config.dbPath, ".."), { recursive: true });
  const db = openDatabase(config.dbPath);
  const events = new EventLog(db);
  const tools = createRegistry([]);
  const stream = openAiStream({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model });
  const conversation = { db, events, stream, tools };
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
