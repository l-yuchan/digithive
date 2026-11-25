/**
 * Two local providers for the routing QA, plus the QA helpers around them.
 *
 *   bun scripts/qa-routing.ts providers      (default) :8796 quota -> :8797 healthy
 *   bun scripts/qa-routing.ts google                  Calendar/Gmail/OAuth stand-ins
 *   bun scripts/qa-routing.ts seed <db>               seeded account and failed run
 *   bun scripts/qa-routing.ts probe <db> [runId]      run one queued run, or one gmail sync
 *   bun scripts/qa-routing.ts requeue <db> <runId>    put a probe's run back in the queue
 *   bun scripts/qa-routing.ts events <db> <runId>     print one run's events
 *
 * QA only: every host it talks to is on loopback, and fetching is rewritten so a
 * browser run never reaches Google.
 */
import { Database } from "bun:sqlite";

const command = process.argv[2] ?? "providers";

const CAL_PORT = Number(process.env["QA_GOOGLE_PORT"] ?? "8794");
const OAUTH_PORT = Number(process.env["QA_OAUTH_PORT"] ?? "8793");

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Rewrites the real Google hosts to the local stand-ins. */
function installQaFetch(): void {
  const calendar = `http://127.0.0.1:${CAL_PORT}`;
  const oauth = `http://127.0.0.1:${OAUTH_PORT}`;
  const realFetch = fetch.bind(globalThis);
  const rewrite = (raw: string): string => {
    if (raw.startsWith("https://www.googleapis.com"))
      return raw.replace("https://www.googleapis.com", calendar);
    if (raw.startsWith("https://gmail.googleapis.com"))
      return raw.replace("https://gmail.googleapis.com", calendar);
    if (raw.startsWith("https://oauth2.googleapis.com"))
      return raw.replace("https://oauth2.googleapis.com", oauth);
    return raw;
  };
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const raw = input instanceof Request ? input.url : input.toString();
      if (raw.startsWith("https://openidconnect.googleapis.com")) {
        return json({ sub: "qa-subject-1", email: "qa@example.com", email_verified: true });
      }
      return realFetch(rewrite(raw), init);
    },
    { preconnect: realFetch.preconnect },
  );
}

async function providers(): Promise<void> {
  const PRIMARY_PORT = Number(process.env["QA_PRIMARY_PORT"] ?? "8796");
  const BACKUP_PORT = Number(process.env["QA_BACKUP_PORT"] ?? "8797");
  const QUOTA_TIMES = Number(process.env["QA_QUOTA_TIMES"] ?? "1000");
  const streamAnswer = (label: string): Response => {
    const encoder = new TextEncoder();
    const frame = (payload: unknown): Uint8Array =>
      encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(frame({ choices: [{ delta: { content: `[${label}] ` } }] }));
        controller.enqueue(
          frame({ choices: [{ delta: { content: "연결된 경로에서 답했습니다." } }] }),
        );
        controller.enqueue(frame({ choices: [{ delta: {}, finish_reason: "stop" }] }));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };
  const quota = (label: string) =>
    json({ type: "GoUsageLimitError", message: `${label} usage limit reached` }, 429);
  let primaryCalls = 0;
  const handler = (label: string, reply: () => Response) => (request: Request) => {
    if (new URL(request.url).pathname !== "/v1/chat/completions") {
      return new Response("not found", { status: 404 });
    }
    const response = reply();
    console.log(
      JSON.stringify({
        route: label,
        method: request.method,
        status: response.status,
        at: Date.now(),
      }),
    );
    return response;
  };
  const primary = Bun.serve({
    port: PRIMARY_PORT,
    fetch: handler("primary", () => {
      primaryCalls += 1;
      return primaryCalls <= QUOTA_TIMES ? quota("primary") : streamAnswer("primary");
    }),
  });
  const backup = Bun.serve({
    port: BACKUP_PORT,
    fetch: handler("backup", () => streamAnswer("backup")),
  });
  console.log(JSON.stringify({ ready: true, primary: primary.port, backup: backup.port }));
}

function google(): void {
  const START = Date.now();
  const calendar = Bun.serve({
    port: CAL_PORT,
    fetch(request) {
      const url = new URL(request.url);
      console.log(JSON.stringify({ service: "calendar", path: url.pathname, at: Date.now() }));
      if (url.pathname.endsWith("/events")) {
        return json({
          items: [
            {
              id: "qa-event-1",
              summary: "QA 일정: 디자인 리뷰",
              description: "브라우저 검증용 일정",
              start: { dateTime: new Date(START + 3_600_000).toISOString() },
            },
          ],
          nextSyncToken: `qa-cursor-${Date.now()}`,
        });
      }
      if (url.pathname.endsWith("/profile")) {
        return json({ emailAddress: "owner@example.com", historyId: "qa-history" });
      }
      if (url.pathname.endsWith("/messages")) return json({ messages: [{ id: "qa-mail-1" }] });
      if (/\/messages\/[^/]+$/.test(url.pathname)) {
        return json({
          id: "qa-mail-1",
          internalDate: String(Date.now()),
          snippet: "QA 메일 본문",
        });
      }
      return json({ history: [], historyId: "qa-history" });
    },
  });
  const oauth = Bun.serve({
    port: OAUTH_PORT,
    fetch() {
      console.log(JSON.stringify({ service: "oauth", at: Date.now() }));
      return json({ access_token: "qa-refreshed-token", expires_in: 3600 });
    },
  });
  console.log(JSON.stringify({ ready: true, calendar: calendar.port, oauth: oauth.port }));
}

function dbPath(): string {
  const path = process.argv[3];
  if (!path) throw new Error(`usage: qa-routing.ts ${command} <db path>`);
  return path;
}

async function seed(path: string): Promise<void> {
  const secret = process.env["QA_VAULT_SECRET"];
  if (!secret) throw new Error("QA_VAULT_SECRET is required");
  const db = new Database(path, { strict: true });
  const { saveTokens } = await import("../src/integrations/google");
  const { upsertGoogleAccount } = await import("../src/integrations/accounts");
  // A verified identity, but the token is expired: collection must refresh first.
  const account = upsertGoogleAccount(db, { subject: "qa-subject-1", email: "owner@example.com" });
  saveTokens(db, secret, account.id, {
    accessToken: "expired-token",
    refreshToken: "qa-refresh",
    expiresAt: 0,
    scope: "openid email",
  });
  const now = new Date().toISOString();
  const runId = "qa-run-provider-failure";
  db.query(
    `INSERT OR REPLACE INTO runs (id, session_id, origin, goal, status, budget_json, result_json, executor_json, timeout_seconds, created_at, settled_at)
     VALUES (?, NULL, 'schedule', ?, 'failed', '{}', ?, '{"kind":"agent"}', 1800, ?, ?)`,
  ).run(
    runId,
    "아침 브리핑 (공급자 장애 재현)",
    JSON.stringify({
      error:
        "quota_exhausted (HTTP 429): 모든 모델 경로가 실패했습니다. primary/qa-primary: quota_exhausted (HTTP 429): GoUsageLimitError primary usage limit reached (5-hour, resets in 31m)",
      detail: '{"type":"GoUsageLimitError","message":"primary usage limit reached"}',
    }),
    now,
    now,
  );
  const kinds: [string, unknown][] = [
    ["run.started", { runId }],
    [
      "provider.fallback",
      {
        level: "warning",
        decision: "provider.fallback",
        provider: "backup",
        model: "qa-backup",
        failedProvider: "primary",
        reason: "quota_exhausted",
        retryInMs: 900000,
        error: "quota_exhausted (HTTP 429): GoUsageLimitError primary usage limit reached",
      },
    ],
    [
      "provider.exhausted",
      { level: "error", decision: "provider.exhausted", provider: "primary", model: "qa-primary" },
    ],
    [
      "run.failed",
      {
        error: "모든 모델 경로가 실패했습니다.",
        detail: '{"type":"GoUsageLimitError","message":"primary usage limit reached"}',
      },
    ],
  ];
  for (const [kind, payload] of kinds) {
    db.query(
      "INSERT INTO events (run_id, session_id, kind, payload_json, created_at) VALUES (?,NULL,?,?,?)",
    ).run(runId, kind, JSON.stringify(payload), now);
  }
  console.log(JSON.stringify({ account: account.id, runId }));
  db.close();
}

async function probe(): Promise<void> {
  installQaFetch();
  const { createRuntime, loadConfig } = await import("../src/runtime");
  const { claimNext, executeRun } = await import("../src/surfaces/work/runner");
  const { syncGoogleGmail } = await import("../src/integrations/google");
  const { EventLog } = await import("../src/events/log");
  const config = loadConfig();
  const runtime = createRuntime(config);
  const accountId = process.argv[4];
  if (accountId) {
    const outcome = await syncGoogleGmail(
      {
        db: runtime.work.db,
        events: new EventLog(runtime.work.db),
        vaultSecret: config.sessionSecret,
        config: {
          clientId: config.googleClientId,
          clientSecret: config.googleClientSecret,
          redirectUri: config.googleRedirectUri,
        },
        fetchImpl: globalThis.fetch,
      },
      accountId,
    );
    console.log(JSON.stringify(outcome));
    runtime.close();
    return;
  }
  const run = claimNext(runtime.work.db, runtime.work.events, "probe", 2, Date.now(), 45_000);
  console.log(run ? `claimed ${run.id} ${run.executorJson}` : "nothing queued");
  if (run) console.log(`outcome ${await executeRun(runtime.work, run)}`);
  runtime.close();
}

function requeue(path: string): void {
  const runId = process.argv[4];
  if (!runId) throw new Error("usage: qa-routing.ts requeue <db> <runId>");
  const db = new Database(path);
  db.query(
    "UPDATE runs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, settled_at = NULL, result_json = NULL WHERE id = ?",
  ).run(runId);
  console.log(JSON.stringify(db.query("SELECT id,status FROM runs").all()));
  db.close();
}

function events(path: string): void {
  const runId = process.argv[4];
  if (!runId) throw new Error("usage: qa-routing.ts events <db> <runId>");
  const db = new Database(path, { readonly: true });
  for (const row of db
    .query<{ seq: number; kind: string; payload_json: string }, [string]>(
      "SELECT seq,kind,payload_json FROM events WHERE run_id = ? ORDER BY seq",
    )
    .all(runId)) {
    console.log(JSON.stringify(row));
  }
  db.close();
}

const commands: Record<string, () => Promise<void> | void> = {
  providers: () => providers(),
  google: () => google(),
  seed: () => seed(dbPath()),
  // The probe runs against the server's own HARNESS_DB.
  probe: () => probe(),
  requeue: () => requeue(dbPath()),
  events: () => events(dbPath()),
};
const selected = commands[command];
if (!selected) throw new Error(`unknown command: ${command}`);
await selected();
