import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { openDatabase } from "./store/db";
import { EventLog } from "./events/log";
import { createRegistry } from "./tools/registry";
import { builtinTools, WORK_POLICY } from "./tools/builtins";
import { openAiStream } from "./providers/openai";
import { settleExpiredRuns } from "./core/run-state";
import { claimNext, executeRun, reconcileWork, WORK_LIMITS, type WorkDeps } from "./surfaces/work/runner";

const here = import.meta.dir;
const appRoot = resolve(here, "..");

export type HarnessConfig = {
  readonly port: number;
  readonly dbPath: string;
  readonly webRoot: string;
  readonly workspaceRoot: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly maxChars: number;
  readonly maxConcurrent: number;
  readonly leaseMs: number;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): HarnessConfig {
  const dataDir = resolve(appRoot, "data");
  return {
    port: Number(env["PORT"] ?? "8799"),
    dbPath: env["HARNESS_DB"] ?? resolve(dataDir, "harness.db"),
    webRoot: resolve(appRoot, "web/dist"),
    workspaceRoot: resolve(appRoot, "data/workspace"),
    baseUrl: env["MODEL_BASE_URL"] ?? "http://127.0.0.1:8798/v1",
    apiKey: env["MODEL_API_KEY"] ?? "local",
    model: env["MODEL_NAME"] ?? "mock-model",
    maxChars: Number(env["HARNESS_MAX_CHARS"] ?? "24000"),
    maxConcurrent: Number(env["HARNESS_MAX_CONCURRENT"] ?? "2"),
    leaseMs: Number(env["HARNESS_LEASE_MS"] ?? "45000"),
  };
}

/** Shared runtime pieces: the HTTP server and the worker use the same builder. */
export function createRuntime(config: HarnessConfig): { work: WorkDeps; close: () => void } {
  if (config.dbPath !== ":memory:") mkdirSync(resolve(config.dbPath, ".."), { recursive: true });
  mkdirSync(config.workspaceRoot, { recursive: true });
  const db = openDatabase(config.dbPath);
  const events = new EventLog(db);
  const stream = openAiStream({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model });
  const tools = createRegistry(builtinTools({ root: config.workspaceRoot }));
  const work: WorkDeps = {
    db,
    events,
    stream,
    tools,
    policy: WORK_POLICY,
    limits: WORK_LIMITS,
    maxConcurrent: config.maxConcurrent,
    leaseMs: config.leaseMs,
  };
  return { work, close: () => db.close() };
}

export { claimNext, executeRun, reconcileWork, settleExpiredRuns };
