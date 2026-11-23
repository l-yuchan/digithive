import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { AuthGate, hashPassphrase } from "../src/server/auth";
import { openDatabase } from "../src/db/store";
import { SecretVault } from "../src/server/secrets";
import { handler } from "../src/server/main";
import { runLeaseCrashCancel, runReconnect } from "../qa/scenarios/runs";
import { budgetConcurrentUnknown, budgetSettle } from "../qa/scenarios/budget";
import { scriptApproved, scriptEscapeAndTimeout } from "../qa/scenarios/sandbox";
import { agentMalformedAndDisconnect, agentToolRoundtrip, providerFetch, setProviderScript } from "../qa/scenarios/provider";
import { chatBrowser, chatOfflineCancel } from "../qa/browser/chat";
import { filesBrowserRoundtrip, filesHttpFailures } from "../qa/scenarios/files";
import { memoryCorrectBrowser, memoryRevokeInflight } from "../qa/scenarios/memory";
import { oauthCodeRefresh, oauthStateRevocation, oauthTokenFetch, setOauthFixture } from "../qa/scenarios/oauth";
import { calendar410PageFailure, calendarFetch, calendarSyncRecurrence, setCalendarPages } from "../qa/scenarios/calendar";
import {
  authOriginAndExpiry, foundationBadMigration, foundationFixtureFailure, foundationHealth,
} from "../qa/scenarios/foundation";

const ORIGIN = "http://127.0.0.1:4317";
const FIXTURE = "http://127.0.0.1:4318";
const PASSPHRASE = "qa-only-long-passphrase";

class QaArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QaArgumentError";
  }
}

const Arguments = z.object({
  scenario: z.enum([
    "foundation-health", "foundation-bad-migration", "foundation-fixture-failure",
    "auth-origin-and-expiry", "run-reconnect", "run-lease-crash-cancel",
    "budget-settle", "budget-concurrent-unknown", "script-approved", "script-escape-and-timeout",
    "agent-tool-roundtrip", "agent-malformed-and-disconnect", "chat-browser", "chat-offline-cancel",
    "files-browser-roundtrip", "files-path-size-corrupt", "memory-correct-browser", "memory-revoke-inflight",
    "oauth-code-refresh", "oauth-state-revocation", "calendar-sync-recurrence", "calendar-410-pagefailure",
  ]),
  evidence: z.string().min(1),
});

function options(args: readonly string[]): z.infer<typeof Arguments> {
  const pairs: Record<string, string | undefined> = {};
  for (let index = 0; index < args.length; index++) {
    const item = args[index];
    if (item === "--") continue;
    if (item !== "--scenario" && item !== "--evidence") {
      throw new QaArgumentError(`Unknown option: ${item}`);
    }
    pairs[item.slice(2)] = args[++index];
  }
  const parsed = Arguments.safeParse(pairs);
  if (!parsed.success) throw new QaArgumentError("Unknown scenario or missing evidence path");
  return parsed.data;
}

async function portReleased(port: number): Promise<boolean> {
  return new Promise((done) => {
    const probe = createServer();
    probe.once("error", () => done(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
  });
}

async function loginCookie(): Promise<string> {
  const response = await fetch(`${ORIGIN}/api/session`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ passphrase: PASSPHRASE }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  return cookie;
}

async function run(): Promise<void> {
  const input = options(process.argv.slice(2));
  const evidence = resolve(input.evidence);
  await mkdir(evidence, { recursive: true });
  const temporary = await mkdtemp(join(tmpdir(), "digithive-qa-"));
  let db: Database | undefined;
  let app: ReturnType<typeof Bun.serve> | undefined;
  let fixture: ReturnType<typeof Bun.serve> | undefined;
  try {
    const dbPath = join(temporary, "assistant.sqlite");
    db = openDatabase(dbPath);
    const auth = new AuthGate(db, {
      origin: ORIGIN,
      passphraseHash: hashPassphrase(PASSPHRASE),
      sessionKey: "qa-only-session-key-exactly-32-bytes",
      encryptionKey: Buffer.alloc(32, 1).toString("base64"),
    });
    app = Bun.serve({ hostname: "127.0.0.1", port: 4317, fetch: handler(db, auth) });
    fixture = Bun.serve({
      hostname: "127.0.0.1",
      port: 4318,
      fetch: (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/health") return Response.json({ ok: false, schemaVersion: -1 });
        if (path === "/oauth/token") return oauthTokenFetch(request);
        if (path.startsWith("/v1/")) return providerFetch(request);
        if (path.startsWith("/calendar/v3/")) return calendarFetch(request);
        return providerFetch(request);
      },
    });
    const context = { db, dbPath, evidence, fixtureBase: FIXTURE };
    switch (input.scenario) {
      case "foundation-health":
        await foundationHealth(context);
        break;
      case "foundation-bad-migration":
        await foundationBadMigration(context);
        break;
      case "foundation-fixture-failure":
        await foundationFixtureFailure(context);
        break;
      case "auth-origin-and-expiry":
        await authOriginAndExpiry(context);
        break;
      case "run-reconnect":
        await runReconnect(context);
        break;
      case "run-lease-crash-cancel":
        await runLeaseCrashCancel(context);
        break;
      case "budget-settle":
        await budgetSettle({ ...context, base: ORIGIN, cookie: await loginCookie() });
        break;
      case "budget-concurrent-unknown":
        await budgetConcurrentUnknown({ ...context, base: ORIGIN, cookie: await loginCookie() });
        break;
      case "script-approved":
        await scriptApproved(context);
        break;
      case "script-escape-and-timeout":
        await scriptEscapeAndTimeout(context);
        break;
      case "calendar-sync-recurrence":
      case "calendar-410-pagefailure": {
        const vault = new SecretVault(Buffer.alloc(32, 1).toString("base64"));
        const calendar = { db, vault, evidence, fixtureBase: FIXTURE };
        setCalendarPages([]);
        process.env["GOOGLE_CALENDAR_BASE"] = FIXTURE;
        if (input.scenario === "calendar-sync-recurrence") await calendarSyncRecurrence(calendar);
        else await calendar410PageFailure(calendar);
        break;
      }
      case "oauth-code-refresh":
      case "oauth-state-revocation": {
        process.env["GOOGLE_CLIENT_ID"] = "qa-client";
        process.env["GOOGLE_CLIENT_SECRET"] = "qa-secret";
        process.env["GOOGLE_REDIRECT_URI"] = `${ORIGIN}/api/oauth/google/callback`;
        process.env["GOOGLE_AUTH_URL"] = `${FIXTURE}/oauth/auth`;
        process.env["GOOGLE_TOKEN_URL"] = `${FIXTURE}/oauth/token`;
        const vault = new SecretVault(Buffer.alloc(32, 1).toString("base64"));
        const oauth = { db, vault, evidence, base: ORIGIN, cookie: await loginCookie(), fixtureBase: FIXTURE };
        setOauthFixture();
        if (input.scenario === "oauth-code-refresh") await oauthCodeRefresh(oauth);
        else await oauthStateRevocation(oauth);
        break;
      }
      case "memory-correct-browser":
        await memoryCorrectBrowser({ db, evidence, base: ORIGIN, cookie: await loginCookie() });
        break;
      case "memory-revoke-inflight":
        await memoryRevokeInflight({ db, evidence, base: ORIGIN, cookie: await loginCookie() });
        break;
      case "files-browser-roundtrip":
      case "files-path-size-corrupt": {
        const cookie = await loginCookie();
        const fixtureDir = resolve(import.meta.dir, "../tests/fixtures/files");
        const files = { evidence, base: ORIGIN, cookie, fixtureDir };
        if (input.scenario === "files-browser-roundtrip") {
          await filesBrowserRoundtrip(files);
        } else {
          await filesHttpFailures({ ...files, oversized: new Uint8Array(26 * 1024 * 1024) });
        }
        break;
      }
      case "agent-tool-roundtrip":
        await agentToolRoundtrip(context);
        break;
      case "agent-malformed-and-disconnect":
        await agentMalformedAndDisconnect(context);
        break;
      case "chat-browser":
      case "chat-offline-cancel": {
        setProviderScript([{
          body: {
            choices: [{ message: { role: "assistant", content: "fixture answer: 이 단어는 라틴어 어원에서 왔습니다." }, finish_reason: "stop" }],
            usage: { prompt_tokens: 120, completion_tokens: 20 },
          },
        }, {
          body: {
            choices: [{ message: { role: "assistant", content: "fixture answer: 이 단어는 라틴어 어원에서 왔습니다." }, finish_reason: "stop" }],
            usage: { prompt_tokens: 140, completion_tokens: 20 },
          },
        }]);
        const workers: (typeof Bun.spawn.prototype | Awaited<ReturnType<typeof Bun.spawn>>)[] = [];
        const startWorker = async (): Promise<void> => {
          workers.push(Bun.spawn([process.execPath, "scripts/worker.ts"], {
            env: {
              ...process.env,
              ASSISTANT_DB_PATH: dbPath,
              MODEL_BASE_URL: `${FIXTURE}/v1`,
              MODEL_NAME: "fixture-model",
              MODEL_API_KEY: "fixture-key",
              MODEL_PRICE_VERSION: "fixture-v1",
              MODEL_INPUT_MICRO_USD_PER_TOKEN: "1",
              MODEL_OUTPUT_MICRO_USD_PER_TOKEN: "2",
            },
            stdout: "ignore",
            stderr: "pipe",
          }));
        };
        try {
          const browserContext = { base: ORIGIN, evidence, passphrase: PASSPHRASE };
          if (input.scenario === "chat-browser") {
            await startWorker();
            await chatBrowser(browserContext);
          } else {
            await chatOfflineCancel({ ...browserContext, startWorker });
          }
        } finally {
          for (const worker of workers) worker.kill();
          await Promise.all(workers.map((worker) => worker.exited));
        }
        break;
      }
      default:
        throw new QaArgumentError("Unknown scenario");
    }
    console.log(`PASS ${input.scenario}`);
  } finally {
    fixture?.stop(true);
    app?.stop(true);
    db?.close();
    await rm(temporary, { recursive: true, force: true });
    await writeFile(join(evidence, "cleanup.json"), `${JSON.stringify({
      applicationPortClosed: await portReleased(4317),
      fixturePortClosed: await portReleased(4318),
      temporaryRemoved: !existsSync(temporary),
    }, null, 2)}\n`);
  }
}

try {
  await run();
} catch (error) { // no-excuse-ok: catch
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : "Unknown QA failure");
  process.exitCode = error instanceof QaArgumentError ? 2 : 1;
}
