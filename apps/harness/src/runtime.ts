import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { openDatabase } from "./store/db";
import { EventLog } from "./events/log";
import { createRegistry } from "./tools/registry";
import { builtinTools, WORK_POLICY } from "./tools/builtins";
import { openAiStream } from "./providers/openai";
import { settleExpiredRuns } from "./core/run-state";
import {
  claimNext,
  executeRun,
  reconcileWork,
  WORK_LIMITS,
  type WorkDeps,
} from "./surfaces/work/runner";
import { z } from "zod";

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
  readonly passphrase: string;
  readonly sessionSecret: string;
  readonly modelHeaders: string;
  readonly googleClientId: string;
  readonly googleClientSecret: string;
  readonly googleRedirectUri: string;
  readonly canvasBaseUrl: string;
  readonly canvasToken: string;
  readonly vapidPublicKey: string;
  readonly vapidPrivateKey: string;
  readonly vapidSubject: string;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): HarnessConfig {
  const dataDir = resolve(appRoot, "data");
  return {
    port: Number(env["PORT"] ?? "8799"),
    dbPath: resolve(env["HARNESS_DB"] ?? join(dataDir, "harness.db")),
    webRoot: resolve(appRoot, "web/dist"),
    workspaceRoot: resolve(env["HARNESS_WORKSPACE"] ?? join(dataDir, "workspace")),
    baseUrl: env["MODEL_BASE_URL"] ?? "http://127.0.0.1:8798/v1",
    apiKey: env["MODEL_API_KEY"] ?? "local",
    model: env["MODEL_NAME"] ?? "mock-model",
    maxChars: Number(env["HARNESS_MAX_CHARS"] ?? "24000"),
    maxConcurrent: Number(env["HARNESS_MAX_CONCURRENT"] ?? "2"),
    leaseMs: Number(env["HARNESS_LEASE_MS"] ?? "45000"),
    passphrase: env["HARNESS_PASSPHRASE"] ?? "",
    sessionSecret: env["HARNESS_SESSION_SECRET"] ?? crypto.randomUUID(),
    modelHeaders: env["HARNESS_MODEL_HEADERS"] ?? "",
    googleClientId: env["GOOGLE_CLIENT_ID"] ?? "",
    googleClientSecret: env["GOOGLE_CLIENT_SECRET"] ?? "",
    googleRedirectUri:
      env["GOOGLE_REDIRECT_URI"] ?? "https://digithive.chanoil.com/api/oauth/google/callback",
    canvasBaseUrl: env["CANVAS_URL"] ?? env["CANVAS_HOST"] ?? "",
    canvasToken: env["CANVAS_TOKEN"] ?? "",
    vapidPublicKey: env["VAPID_PUBLIC_KEY"] ?? "",
    vapidPrivateKey: env["VAPID_PRIVATE_KEY"] ?? "",
    vapidSubject: env["VAPID_SUBJECT"] ?? "mailto:owner@digithive.local",
  };
}

/** Shared runtime pieces: the HTTP server and the worker use the same builder. */
export function createRuntime(config: HarnessConfig): { work: WorkDeps; close: () => void } {
  if (config.dbPath !== ":memory:") mkdirSync(resolve(config.dbPath, ".."), { recursive: true });
  mkdirSync(config.workspaceRoot, { recursive: true });
  const db = openDatabase(config.dbPath);
  const events = new EventLog(db);
  const stream = openAiStream({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    headers: parseHeaders(config.modelHeaders),
  });
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

function parseHeaders(raw: string): Record<string, string> {
  if (raw.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(z.record(z.string(), z.unknown()).parse(parsed))) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}
