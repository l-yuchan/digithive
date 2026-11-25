import { dirname, join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { openDatabase } from "./store/db";
import { EventLog } from "./events/log";
import { createRegistry } from "./tools/registry";
import { builtinTools, WORK_POLICY } from "./tools/builtins";
import { personalTools } from "./tools/personal";
import { scheduleTools } from "./tools/schedules";
import { memoryTools } from "./tools/memory";
import { fileTools } from "./tools/files";
import { createBuiltinExecutor } from "./scheduler/builtins";
import { createRoutingStream, type ProviderRouteConfig } from "./providers/router";
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
  readonly filesRoot: string;
  readonly maxUploadBytes: number;
  readonly scriptsRoot: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  /** Optional fallback routes in order; MODEL_PROVIDERS_JSON wins over them. */
  readonly fallbackProviders: readonly ProviderRouteConfig[];
  readonly providerCooldownMs: number;
  readonly providerRetries: number;
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
  if (env["GOOGLE_CLIENT_ID"] && !env["HARNESS_SESSION_SECRET"]) {
    throw new Error(
      "HARNESS_SESSION_SECRET is required to share Google credentials across processes",
    );
  }
  const dataDir = resolve(appRoot, "data");
  const dbPath = resolve(env["HARNESS_DB"] ?? join(dataDir, "harness.db"));
  const workspaceRoot = resolve(env["HARNESS_WORKSPACE"] ?? join(dataDir, "workspace"));
  return {
    port: Number(env["PORT"] ?? "8799"),
    dbPath,
    webRoot: resolve(appRoot, "web/dist"),
    workspaceRoot,
    filesRoot: resolve(env["HARNESS_FILES"] ?? join(dirname(dbPath), "files")),
    maxUploadBytes: z.coerce
      .number()
      .int()
      .positive()
      .max(100 * 1024 * 1024)
      .parse(env["HARNESS_MAX_UPLOAD_BYTES"] ?? 10 * 1024 * 1024),
    scriptsRoot: resolve(env["HARNESS_SCRIPTS_ROOT"] ?? join(workspaceRoot, "..", "scripts")),
    baseUrl: env["MODEL_BASE_URL"] ?? "http://127.0.0.1:8798/v1",
    apiKey: env["MODEL_API_KEY"] ?? "local",
    model: env["MODEL_NAME"] ?? "mock-model",
    fallbackProviders: parseFallbackProviders(env["MODEL_FALLBACKS_JSON"] ?? ""),
    providerCooldownMs: Number(env["MODEL_COOLDOWN_MS"] ?? "900000"),
    providerRetries: Number(env["MODEL_RETRIES"] ?? "1"),
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
  mkdirSync(config.scriptsRoot, { recursive: true });
  const db = openDatabase(config.dbPath);
  const events = new EventLog(db);
  const primary: ProviderRouteConfig = {
    name: "primary",
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    headers: parseHeaders(config.modelHeaders),
  };
  const stream = createRoutingStream(
    { primary, fallbacks: config.fallbackProviders },
    { cooldownMs: config.providerCooldownMs, retries: config.providerRetries },
  );
  const tools = createRegistry([
    ...builtinTools({ root: config.workspaceRoot }),
    ...personalTools({
      db,
      events,
      vaultSecret: config.sessionSecret,
      config: {
        clientId: config.googleClientId,
        clientSecret: config.googleClientSecret,
        redirectUri: config.googleRedirectUri,
      },
    }),
    ...scheduleTools({ db, events }),
    ...memoryTools(db),
    ...fileTools(db),
  ]);
  const work: WorkDeps = {
    db,
    events,
    stream,
    tools,
    policy: WORK_POLICY,
    limits: WORK_LIMITS,
    streamDiagnostics: (diagnostics) => {
      for (const diagnostic of diagnostics) {
        console.log(`provider ${diagnostic.kind}: ${JSON.stringify(diagnostic)}`);
      }
    },
    maxConcurrent: config.maxConcurrent,
    leaseMs: config.leaseMs,
    scriptsRoot: config.scriptsRoot,
    scriptExecutor: createBuiltinExecutor({
      google: {
        db,
        events,
        vaultSecret: config.sessionSecret,
        config: {
          clientId: config.googleClientId,
          clientSecret: config.googleClientSecret,
          redirectUri: config.googleRedirectUri,
        },
      },
      canvas: { db, events, config: { baseUrl: config.canvasBaseUrl, token: config.canvasToken } },
      push: {
        publicKey: config.vapidPublicKey,
        privateKey: config.vapidPrivateKey,
        subject: config.vapidSubject,
      },
    }),
  };
  return { work, close: () => db.close() };
}

export { claimNext, executeRun, reconcileWork, settleExpiredRuns };

/**
 * MODEL_FALLBACKS_JSON: `[{name, baseUrl, apiKey, model, headers?}]`, tried in
 * order after MODEL_BASE_URL. An invalid entry fails loudly at startup: a
 * silently dropped fallback would only surface when the primary runs out of quota.
 */
function parseFallbackProviders(raw: string): ProviderRouteConfig[] {
  if (raw.trim().length === 0) return [];
  const parsed: unknown = JSON.parse(raw);
  const routes = z
    .array(
      z.object({
        name: z.string().min(1),
        baseUrl: z.string().min(1),
        apiKey: z.string().min(1),
        model: z.string().min(1),
        headers: z.record(z.string(), z.string()).optional(),
      }),
    )
    .safeParse(parsed);
  if (!routes.success) {
    throw new Error(`MODEL_FALLBACKS_JSON is invalid: ${routes.error.message}`);
  }
  return routes.data.map(({ headers, ...route }) =>
    headers === undefined ? route : { ...route, headers },
  );
}

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
