import { ok } from "node:assert/strict";
import { afterEach, describe, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { z } from "zod";
import { migrate } from "../src/store/db";
import { EventLog } from "../src/events/log";
import {
  applyAccountEmail,
  consumeOAuthState,
  createOAuthState,
  DEFAULT_CANVAS_ACCOUNT_ID,
  DEFAULT_GOOGLE_ACCOUNT_ID,
  getAccount,
  listAccounts,
  OAUTH_STATE_TTL_MS,
  setSourceEnabled,
  upsertGoogleAccount,
} from "../src/integrations/accounts";
import {
  authUrl,
  loadTokens,
  saveTokens,
  syncGoogleCalendar,
  syncGoogleGmail,
  type GoogleDeps,
} from "../src/integrations/google";
import { collectSources, type SyncSourcesDeps } from "../src/integrations/sync";
import { syncStates } from "../src/integrations/normalize";
import { handleAccountRequest } from "../src/server/account-routes";
import { handleWorkflowRequest } from "../src/server/workflow-routes";
import { personalTools } from "../src/tools/personal";

const SECRET = "accounts-test-secret";
const NOW = Date.parse("2026-11-25T10:00:00.000Z");
const LATER = NOW + 3_600_000;
const config = {
  clientId: "cid",
  clientSecret: "csecret",
  redirectUri: "https://local/api/oauth/google/callback",
};

const AccountsBody = z.object({
  accounts: z.array(
    z.object({
      id: z.string(),
      connected: z.boolean(),
      collectors: z.array(z.object({ id: z.string(), title: z.string(), enabled: z.boolean() })),
      sources: z.array(z.object({ source: z.string(), enabled: z.boolean() })),
    }),
  ),
  googleConfigured: z.boolean(),
  canvasConfigured: z.boolean(),
});

const SearchBody = z.object({
  items: z.array(z.object({ accountId: z.string(), item_id: z.string() })),
  states: z.array(z.object({ accountId: z.string(), enabled: z.boolean() })),
  state: z.object({ accountId: z.string(), enabled: z.boolean() }).nullable(),
});

const GmailSearchBody = z.object({
  messages: z.array(z.object({ id: z.string(), accountId: z.string(), detail: z.string() })),
  errors: z.array(z.object({ accountId: z.string(), error: z.string() })),
  accounts: z.array(z.object({ id: z.string() })),
});

const ErrorBody = z.object({ error: z.string() });

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function fresh(): Database {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function fakeFetch(
  handler: (url: URL, init?: Parameters<typeof fetch>[1]) => Promise<Response> | Response,
): typeof fetch {
  return Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      handler(new URL(input instanceof Request ? input.url : input.toString()), init),
    { preconnect: fetch.preconnect },
  );
}

function bearer(init?: Parameters<typeof fetch>[1]): string {
  return new Headers(init?.headers).get("authorization") ?? "";
}

/** The gmail cursor the source actually reads; writes to last_sync_at prove nothing. */
function gmailCursor(db: Database, accountId: string): string | null {
  const row = db
    .query<{ cursor: string | null }, SQLQueryBindings[]>(
      "SELECT cursor FROM account_sources WHERE account_id=? AND source='gmail'",
    )
    .get(accountId);
  return row?.cursor ?? null;
}

function addGoogle(
  db: Database,
  email: string,
  subject: string,
  accessToken: string,
  expiresAt = LATER,
  refreshToken: string | null = `rt-${email}`,
): string {
  const { id } = upsertGoogleAccount(db, { subject, email, label: email });
  saveTokens(db, SECRET, id, { accessToken, refreshToken, expiresAt, scope: null });
  return id;
}

function googleDeps(
  db: Database,
  events: EventLog,
  fetchImpl: typeof fetch,
  now = () => NOW,
): GoogleDeps {
  return { db, events, config, vaultSecret: SECRET, fetchImpl, now };
}

function routeDeps(google: GoogleDeps) {
  return {
    google,
    canvas: {
      db: google.db,
      events: google.events,
      config: { baseUrl: "", token: "" },
    },
    auth: { passphrase: "", secret: SECRET },
  };
}

function calendarAndMailFetch(calls: string[] = []): typeof fetch {
  return fakeFetch((url, init) => {
    const auth = bearer(init);
    calls.push(`${url.hostname}${url.pathname}?${url.search} ${auth}`);
    if (url.hostname === "www.googleapis.com" && url.pathname.includes("/events"))
      return json({
        items: [{ id: "same-event", summary: auth === "Bearer at-a" ? "A 일정" : "B 일정" }],
        nextSyncToken: `cursor-${auth.replace("Bearer ", "")}`,
      });
    if (url.pathname.endsWith("/history"))
      return json({
        history: [{ messagesAdded: [{ message: { id: "same-mail" } }] }],
        historyId: `history-${auth.replace("Bearer ", "")}`,
      });
    if (/\/messages\/[^/]+$/.test(url.pathname))
      return json({
        id: "same-mail",
        internalDate: "1795500000000",
        snippet: auth === "Bearer at-a" ? "A 메일" : "B 메일",
      });
    return json({ error: "unexpected" }, 404);
  });
}

describe("account-scoped sync", () => {
  test("two accounts store the same item and cursor ids independently", async () => {
    const db = fresh();
    const events = new EventLog(db);
    const a = addGoogle(db, "a@example.com", "sub-a", "at-a");
    const b = addGoogle(db, "b@example.com", "sub-b", "at-b");
    db.query(
      "UPDATE account_sources SET cursor='old-a', ok=1 WHERE account_id=? AND source='gmail'",
    ).run(a);
    db.query(
      "UPDATE account_sources SET cursor='old-b', ok=1 WHERE account_id=? AND source='gmail'",
    ).run(b);
    const deps = googleDeps(db, events, calendarAndMailFetch());

    expect(await syncGoogleCalendar(deps, a)).toMatchObject({ ok: true, accountId: a });
    expect(await syncGoogleCalendar(deps, b)).toMatchObject({ ok: true, accountId: b });
    expect(await syncGoogleGmail(deps, a)).toMatchObject({ ok: true, accountId: a });
    expect(await syncGoogleGmail(deps, b)).toMatchObject({ ok: true, accountId: b });

    const items = db
      .query<
        {
          account_id: string;
          item_id: string;
          title: string;
          source: string;
          email: string;
        },
        SQLQueryBindings[]
      >(
        "SELECT i.account_id,i.item_id,i.title,i.source,a.email FROM sync_items i JOIN integration_accounts a ON a.id = i.account_id ORDER BY i.source, a.email",
      )
      .all();
    expect(items).toEqual([
      {
        account_id: a,
        item_id: "same-event",
        title: "A 일정",
        source: "calendar",
        email: "a@example.com",
      },
      {
        account_id: b,
        item_id: "same-event",
        title: "B 일정",
        source: "calendar",
        email: "b@example.com",
      },
      {
        account_id: a,
        item_id: "same-mail",
        title: "(제목 없음)",
        source: "gmail",
        email: "a@example.com",
      },
      {
        account_id: b,
        item_id: "same-mail",
        title: "(제목 없음)",
        source: "gmail",
        email: "b@example.com",
      },
    ]);
    const cursors = db
      .query<{ account_id: string; source: string; cursor: string }, SQLQueryBindings[]>(
        "SELECT account_id,source,cursor FROM account_sources WHERE account_id IN (?,?) ORDER BY source, cursor",
      )
      .all(a, b);
    expect(cursors).toEqual([
      { account_id: a, source: "calendar", cursor: "cursor-at-a" },
      { account_id: b, source: "calendar", cursor: "cursor-at-b" },
      { account_id: a, source: "gmail", cursor: "history-at-a" },
      { account_id: b, source: "gmail", cursor: "history-at-b" },
    ]);
  });

  test("disabling one account's gmail leaves its calendar and the other account alone", async () => {
    const db = fresh();
    const events = new EventLog(db);
    const a = addGoogle(db, "a@example.com", "sub-a", "at-a");
    const b = addGoogle(db, "b@example.com", "sub-b", "at-b");
    db.query(
      "UPDATE account_sources SET cursor='1', ok=1 WHERE account_id=? AND source='gmail'",
    ).run(a);
    db.query(
      "UPDATE account_sources SET cursor='2', ok=1 WHERE account_id=? AND source='gmail'",
    ).run(b);
    setSourceEnabled(db, b, "gmail", false);
    setSourceEnabled(db, DEFAULT_CANVAS_ACCOUNT_ID, "canvas", false);
    const calls: string[] = [];
    const deps = googleDeps(db, events, calendarAndMailFetch(calls));

    const syncDeps: SyncSourcesDeps = { google: deps, canvas: routeDeps(deps).canvas };
    const results = await collectSources(syncDeps, { accountId: b });
    const byAccount = results.filter((row) => row.accountId === b);
    expect(byAccount.map((row) => `${row.source}:${row.error ?? "ok"}`)).toEqual(
      expect.arrayContaining(["calendar:ok", "gmail:source_disabled"]),
    );
    expect(calls.some((call) => call.includes("/history") && call.includes("at-b"))).toBe(false);
    expect(gmailCursor(db, b)).toBe("2");

    const direct = await syncGoogleGmail(deps, b);
    expect(direct).toMatchObject({ ok: false, skipped: true, error: "source_disabled" });
    expect(gmailCursor(db, b)).toBe("2");
  });

  test("a collection run reads only the sources it names, and refuses a foreign source", async () => {
    const db = fresh();
    const events = new EventLog(db);
    const a = addGoogle(db, "a@example.com", "sub-a", "at-a");
    db.query(
      "UPDATE account_sources SET cursor='1', ok=1 WHERE account_id=? AND source='gmail'",
    ).run(a);
    const calls: string[] = [];
    const deps = googleDeps(db, events, calendarAndMailFetch(calls));
    const syncDeps: SyncSourcesDeps = { google: deps, canvas: routeDeps(deps).canvas };

    const gmailOnly = await collectSources(syncDeps, { accountId: a, sources: ["gmail"] });
    expect(gmailOnly.map((row) => row.source)).toEqual(["gmail"]);
    expect(calls.some((call) => call.includes("/events"))).toBe(false);

    const foreign = collectSources(syncDeps, { accountId: a, sources: ["canvas"] });
    await expect(foreign).rejects.toThrow(/source_not_supported: google account/);
    const missing = collectSources(syncDeps, { accountId: "missing" });
    await expect(missing).rejects.toThrow(/account_not_found: missing/);
  });

  test("a disabled feature refuses collection and its cached data, and re-enabling restores it", async () => {
    const db = fresh();
    const events = new EventLog(db);
    const a = addGoogle(db, "a@example.com", "sub-a", "at-a");
    const calls: string[] = [];
    const deps = googleDeps(db, events, calendarAndMailFetch(calls));
    const syncDeps: SyncSourcesDeps = { google: deps, canvas: routeDeps(deps).canvas };
    db.query(
      "UPDATE account_sources SET cursor='1', ok=1 WHERE account_id=? AND source='gmail'",
    ).run(a);
    expect(await collectSources(syncDeps, { accountId: a, sources: ["gmail"] })).toEqual([
      expect.objectContaining({ source: "gmail", ok: true, cursor: "history-at-a" }),
    ]);
    const cached = db
      .query<{ n: number }, SQLQueryBindings[]>(
        "SELECT count(*) AS n FROM sync_items WHERE account_id=? AND source='gmail'",
      )
      .get(a);
    expect(cached?.n).toBe(1);

    expect(setSourceEnabled(db, a, "gmail", false)).toMatchObject({ enabled: false });
    const disabled = await collectSources(syncDeps, { accountId: a, sources: ["gmail"] });
    expect(disabled).toEqual([
      expect.objectContaining({
        source: "gmail",
        ok: false,
        skipped: true,
        error: "source_disabled",
      }),
    ]);
    const search = personalTools(deps).find((tool) => tool.name === "personal_data_search");
    const body = SearchBody.parse(
      JSON.parse(
        (await search?.execute({ source: "gmail", query: "메일", accountId: a }, { runId: "r" })) ??
          "{}",
      ),
    );
    expect(body.items).toEqual([]);
    expect(body.states).toEqual([expect.objectContaining({ accountId: a, enabled: false })]);

    expect(setSourceEnabled(db, a, "gmail", true)).toMatchObject({ enabled: true });
    const again = SearchBody.parse(
      JSON.parse(
        (await search?.execute({ source: "gmail", query: "메일", accountId: a }, { runId: "r" })) ??
          "{}",
      ),
    );
    expect(again.items).toHaveLength(1);
  });

  test("one failing token does not disturb the other account's tokens or items", async () => {
    const db = fresh();
    const events = new EventLog(db);
    const healthy = addGoogle(db, "ok@example.com", "sub-ok", "at-ok", LATER);
    const broken = addGoogle(db, "bad@example.com", "sub-bad", "expired-bad", 0, "rt-bad");
    setSourceEnabled(db, DEFAULT_CANVAS_ACCOUNT_ID, "canvas", false);
    const deps = googleDeps(
      db,
      events,
      fakeFetch((url, init) => {
        if (url.hostname === "oauth2.googleapis.com") {
          const body =
            init?.body instanceof URLSearchParams
              ? init.body
              : new URLSearchParams(typeof init?.body === "string" ? init.body : "");
          return body.get("refresh_token") === "rt-bad"
            ? json({ error: "invalid_grant" }, 400)
            : json({ access_token: "refreshed-ok", expires_in: 3600 });
        }
        if (url.pathname.includes("/events"))
          return json({ items: [{ id: "e1", summary: "일정" }], nextSyncToken: "c1" });
        return json({ history: [], historyId: "h1" });
      }),
    );

    const deps2: SyncSourcesDeps = { google: deps, canvas: routeDeps(deps).canvas };
    const results = [
      ...(await collectSources(deps2, { accountId: healthy })),
      ...(await collectSources(deps2, { accountId: broken })),
    ];
    expect(results.filter((row) => row.accountId === healthy).every((row) => row.ok)).toBe(true);
    const failed = results.filter((row) => row.accountId === broken);
    expect(failed).toHaveLength(2);
    expect(failed.every((row) => !row.ok && row.error?.startsWith("oauth_http_"))).toBe(true);

    expect(db.query("SELECT count(*) AS n FROM sync_items WHERE account_id=?").get(broken)).toEqual(
      { n: 0 },
    );
    expect(loadTokens(db, SECRET, broken)).toMatchObject({
      accessToken: "expired-bad",
      refreshToken: "rt-bad",
      expiresAt: 0,
    });
    expect(loadTokens(db, SECRET, healthy)?.accessToken).toBe("at-ok");
  });
});

describe("verified identity and OAuth challenge", () => {
  test("oauth state is persisted, single use and expires after ten minutes", () => {
    const db = fresh();
    const state = createOAuthState(db, null, NOW);
    expect(
      db
        .query<{ n: number }, SQLQueryBindings[]>(
          "SELECT count(*) AS n FROM oauth_states WHERE state=?",
        )
        .get(state),
    ).toEqual({ n: 1 });
    expect(consumeOAuthState(db, state, NOW + 1_000)).toEqual({ ok: true, accountId: null });
    expect(consumeOAuthState(db, state, NOW + 2_000)).toEqual({ ok: false, reason: "invalid" });

    const expiring = createOAuthState(db, null, NOW);
    expect(consumeOAuthState(db, expiring, NOW + OAUTH_STATE_TTL_MS + 1)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  test("start persists a reconnect target and the callback keeps the old refresh token", async () => {
    const db = fresh();
    const events = new EventLog(db);
    const account = addGoogle(db, "keep@example.com", "sub-keep", "old-access", LATER, "rt-old");
    const fetchImpl = fakeFetch((url) => {
      if (url.hostname === "oauth2.googleapis.com")
        return json({ access_token: "new-access", expires_in: 3600 });
      if (url.hostname === "openidconnect.googleapis.com")
        return json({ sub: "sub-keep", email: "keep@example.com", email_verified: true });
      if (url.pathname.includes("/events")) return json({ items: [], nextSyncToken: "c" });
      return json({ history: [], historyId: "h" });
    });
    const deps = routeDeps(googleDeps(db, events, fetchImpl));
    const start = await handleAccountRequest(
      new Request(`https://local/api/oauth/google/start?accountId=${encodeURIComponent(account)}`),
      deps,
    );
    ok(start, "start route matched");
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get("location") ?? "");
    const state = location.searchParams.get("state") ?? "";
    expect(location.searchParams.get("scope")).toContain("openid");
    expect(location.searchParams.get("scope")).toContain("email");

    const callback = await handleAccountRequest(
      new Request(
        `https://local/api/oauth/google/callback?code=c&state=${encodeURIComponent(state)}`,
      ),
      deps,
    );
    ok(callback, "callback route matched");
    const result = new URL(callback.headers.get("location") ?? "");
    expect(result.searchParams.get("oauth")).toBe("ok");
    expect(result.searchParams.get("account")).toBe(account);
    expect(loadTokens(db, SECRET, account)).toMatchObject({
      accessToken: "new-access",
      refreshToken: "rt-old",
    });

    const replay = await handleAccountRequest(
      new Request(
        `https://local/api/oauth/google/callback?code=c&state=${encodeURIComponent(state)}`,
      ),
      deps,
    );
    ok(replay, "replay matched");
    expect(new URL(replay.headers.get("location") ?? "").searchParams.get("reason")).toBe(
      "state_invalid",
    );
  });

  test("adding a new account uses the verified subject and never duplicates it", async () => {
    const db = fresh();
    const events = new EventLog(db);
    let userinfoReads = 0;
    const fetchImpl = fakeFetch((url) => {
      if (url.hostname === "oauth2.googleapis.com")
        return json({ access_token: "new-access", refresh_token: "rt-new", expires_in: 3600 });
      if (url.hostname === "openidconnect.googleapis.com") {
        userinfoReads += 1;
        return json({ sub: "sub-new", email: "new@example.com", email_verified: true });
      }
      if (url.pathname.includes("/events")) return json({ items: [], nextSyncToken: "c" });
      return json({ history: [], historyId: "h" });
    });
    const deps = routeDeps(googleDeps(db, events, fetchImpl));
    const first = createOAuthState(db, null);
    const response = await handleAccountRequest(
      new Request(`https://local/api/oauth/google/callback?code=c&state=${first}`),
      deps,
    );
    ok(response, "callback matched");
    const location = new URL(response.headers.get("location") ?? "");
    const createdId = location.searchParams.get("account");
    ok(createdId, "account id returned");
    expect(getAccount(db, createdId)).toMatchObject({
      provider: "google",
      subject: "sub-new",
      email: "new@example.com",
    });

    const second = createOAuthState(db, null);
    await handleAccountRequest(
      new Request(`https://local/api/oauth/google/callback?code=c&state=${second}`),
      deps,
    );
    const count = db
      .query<{ n: number }, SQLQueryBindings[]>(
        "SELECT count(*) AS n FROM integration_accounts WHERE provider='google' AND subject='sub-new'",
      )
      .get();
    expect(count).toEqual({ n: 1 });
    expect(userinfoReads).toBe(2);
  });

  test("a reconnect to a different identity is rejected without overwriting either account", async () => {
    const db = fresh();
    const events = new EventLog(db);
    const target = addGoogle(
      db,
      "target@example.com",
      "sub-target",
      "old-access",
      LATER,
      "rt-target",
    );
    const fetchImpl = fakeFetch((url) => {
      if (url.hostname === "oauth2.googleapis.com")
        return json({ access_token: "intruder-access", expires_in: 3600 });
      if (url.hostname === "openidconnect.googleapis.com")
        return json({ sub: "sub-other", email: "other@example.com", email_verified: true });
      return json({ items: [], nextSyncToken: "c" });
    });
    const deps = routeDeps(googleDeps(db, events, fetchImpl));
    const state = createOAuthState(db, target);
    const response = await handleAccountRequest(
      new Request(`https://local/api/oauth/google/callback?code=c&state=${state}`),
      deps,
    );
    ok(response, "callback matched");
    expect(new URL(response.headers.get("location") ?? "").searchParams.get("reason")).toBe(
      "identity_mismatch",
    );
    expect(getAccount(db, target)).toMatchObject({
      subject: "sub-target",
      email: "target@example.com",
    });
    expect(loadTokens(db, SECRET, target)?.accessToken).toBe("old-access");
  });

  test("the legacy account is adopted only by a verified matching email, never by order", () => {
    const db = fresh();
    const unverified = upsertGoogleAccount(db, { subject: "sub-legacy", email: null });
    expect(unverified.id).not.toBe(DEFAULT_GOOGLE_ACCOUNT_ID);

    applyAccountEmail(db, DEFAULT_GOOGLE_ACCOUNT_ID, "legacy@example.com");
    const adopted = upsertGoogleAccount(db, {
      subject: "sub-legacy-mail",
      email: "legacy@example.com",
    });
    expect(adopted.id).toBe(DEFAULT_GOOGLE_ACCOUNT_ID);
    expect(adopted.created).toBe(false);

    const different = upsertGoogleAccount(db, {
      subject: "sub-other",
      email: "different@example.com",
    });
    expect(different.id).not.toBe(DEFAULT_GOOGLE_ACCOUNT_ID);
    expect(different.created).toBe(true);
  });
});

describe("account API and tools", () => {
  test("the seeded google placeholder is not connected until a token exists", async () => {
    const db = fresh();
    const events = new EventLog(db);
    const deps = routeDeps(
      googleDeps(
        db,
        events,
        fakeFetch(() => json({ error: "unused" }, 404)),
      ),
    );
    const response = await handleAccountRequest(new Request("https://local/api/accounts"), deps);
    ok(response, "accounts route matched");
    const body = AccountsBody.parse(await response.json());
    expect(body.googleConfigured).toBe(true);
    expect(body.canvasConfigured).toBe(false);
    const google = body.accounts.find((account) => account.id === DEFAULT_GOOGLE_ACCOUNT_ID);
    expect(google?.connected).toBe(false);
    expect(google?.sources.map((source) => [source.source, source.enabled])).toEqual([
      ["calendar", true],
      ["gmail", true],
    ]);
    const canvas = body.accounts.find((account) => account.id === DEFAULT_CANVAS_ACCOUNT_ID);
    expect(canvas?.connected).toBe(false);

    addGoogle(db, "live@example.com", "sub-live", "at-live");
    const listed = listAccounts(db);
    expect(listed.find((account) => account.email === "live@example.com")?.connected).toBe(true);
  });

  test("personal_data_search excludes a disabled source even when it is targeted", async () => {
    const db = fresh();
    const events = new EventLog(db);
    const a = addGoogle(db, "a@example.com", "sub-a", "at-a");
    const b = addGoogle(db, "b@example.com", "sub-b", "at-b");
    const insert = db.query(
      "INSERT INTO sync_items(account_id,source,item_id,title,at,detail,url,updated_at) VALUES (?,?,?,?,?,?,?,?)",
    );
    insert.run(a, "gmail", "same", "회의 A", "2026-11-25T00:00:00.000Z", "공유", null, "x");
    insert.run(b, "gmail", "same", "회의 B", "2026-11-25T00:00:00.000Z", "공유", null, "x");
    const tool = personalTools(
      googleDeps(
        db,
        events,
        fakeFetch(() => json({ error: "unused" }, 404)),
      ),
    ).find((entry) => entry.name === "personal_data_search");
    ok(tool, "personal_data_search registered");
    expect(tool.conversation).toBe(true);

    const search = async (accountId?: string) => {
      const raw: unknown = JSON.parse(
        await tool.execute(
          { source: "gmail", query: "회의", ...(accountId ? { accountId } : {}) },
          { runId: "test" },
        ),
      );
      return SearchBody.parse(raw);
    };

    expect((await search()).items.map((item) => item.accountId).toSorted()).toEqual(
      [a, b].toSorted(),
    );
    setSourceEnabled(db, b, "gmail", false);
    expect((await search()).items.map((item) => item.accountId)).toEqual([a]);
    const explicit = await search(b);
    expect(explicit.items).toEqual([]);
    expect(explicit.state).toMatchObject({ accountId: b, enabled: false });

    saveTokens(db, SECRET, a, {
      accessToken: "at-a",
      refreshToken: null,
      expiresAt: LATER,
      scope: null,
    });
    const gmailStates = syncStates(db)
      .filter((row) => row.source === "gmail")
      .map((row) => row.accountId);
    expect(gmailStates).toContain(a);
    expect(gmailStates).toContain(b);
  });

  test("gmail_search reports per-account results and failures without choosing one account", async () => {
    const db = fresh();
    const events = new EventLog(db);
    const healthy = addGoogle(db, "ok@example.com", "sub-ok", "at-ok", LATER);
    addGoogle(db, "bad@example.com", "sub-bad", "expired", 0, "rt-bad");
    const fetchImpl = fakeFetch((url, init) => {
      if (url.hostname === "oauth2.googleapis.com") return json({ error: "invalid_grant" }, 400);
      const auth = bearer(init);
      if (url.pathname === "/gmail/v1/users/me/messages") return json({ messages: [{ id: "m1" }] });
      return json({
        id: "m1",
        internalDate: "1795500000000",
        snippet: auth === "Bearer at-ok" ? "건강한 계정" : "실패 계정",
      });
    });
    const tool = personalTools(googleDeps(db, events, fetchImpl)).find(
      (entry) => entry.name === "gmail_search",
    );
    ok(tool, "gmail_search registered");
    const raw: unknown = JSON.parse(
      await tool.execute({ query: "회의", limit: 2 }, { runId: "test" }),
    );
    const result = GmailSearchBody.parse(raw);
    expect(result.messages.map((message) => message.accountId)).toEqual([healthy]);
    expect(result.messages[0]?.detail).toBe("건강한 계정");
    expect(result.accounts).toHaveLength(2);
    expect(result.errors.some((entry) => entry.error.startsWith("oauth_http_"))).toBe(true);
  });

  test("PATCH toggles only the addressed source and DELETE removes only that account", async () => {
    const db = fresh();
    const events = new EventLog(db);
    const a = addGoogle(db, "a@example.com", "sub-a", "at-a");
    const deps = routeDeps(
      googleDeps(
        db,
        events,
        fakeFetch(() => json({ error: "unused" }, 404)),
      ),
    );
    const patch = await handleAccountRequest(
      new Request(`https://local/api/accounts/${a}/sources/gmail`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: false }),
      }),
      deps,
    );
    ok(patch, "patch matched");
    expect(patch.status).toBe(200);
    expect(
      db
        .query<{ enabled: number }, SQLQueryBindings[]>(
          "SELECT enabled FROM account_sources WHERE account_id=? AND source='gmail'",
        )
        .get(a),
    ).toEqual({ enabled: 0 });
    expect(
      db
        .query<{ enabled: number }, SQLQueryBindings[]>(
          "SELECT enabled FROM account_sources WHERE account_id=? AND source='calendar'",
        )
        .get(a),
    ).toEqual({ enabled: 1 });

    const bad = await handleAccountRequest(
      new Request(`https://local/api/accounts/${a}/sources/canvas`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: false }),
      }),
      deps,
    );
    ok(bad, "bad patch matched");
    expect(bad.status).toBe(422);
    expect(ErrorBody.parse(await bad.json()).error).toBe("source_not_supported");

    const removed = await handleAccountRequest(
      new Request(`https://local/api/accounts/${a}`, { method: "DELETE" }),
      deps,
    );
    ok(removed, "delete matched");
    expect(removed.status).toBe(200);
    expect(getAccount(db, a)).toBeNull();
    expect(getAccount(db, DEFAULT_GOOGLE_ACCOUNT_ID)).not.toBeNull();
    expect(db.query("SELECT count(*) AS n FROM sync_items WHERE account_id=?").get(a)).toEqual({
      n: 0,
    });
  });

  test("a saved collection job is refused when its account is gone", async () => {
    const db = fresh();
    const events = new EventLog(db);
    const missing = "11111111-2222-3333-4444-555555555555";
    const deps = { db, events };
    const before = db
      .query<{ n: number }, SQLQueryBindings[]>("SELECT count(*) AS n FROM workflows")
      .get();
    const refused = await handleWorkflowRequest(
      new Request("https://local/api/workflows", {
        method: "POST",
        body: JSON.stringify({
          title: "메일 수집",
          instruction: "메일을 모읍니다",
          executor: {
            kind: "script",
            path: "jobs/collection.ts",
            args: [missing],
            capabilities: ["account.read"],
          },
          timeoutSeconds: 60,
        }),
      }),
      deps,
    );
    ok(refused, "workflow route matched");
    expect(refused.status).toBe(422);
    const body = z.object({ error: z.string(), detail: z.string() }).parse(await refused.json());
    expect(body.error).toBe("collection_not_permitted");
    expect(body.detail).toContain(missing);
    const after = db
      .query<{ n: number }, SQLQueryBindings[]>("SELECT count(*) AS n FROM workflows")
      .get();
    expect(after).toEqual(before);
  });

  test("a collection job is accepted without storing any source list", async () => {
    // The sources come from the account's switches at each run, so a workflow saved
    // while Gmail was on cannot keep reading Gmail after it is turned off.
    const db = fresh();
    const events = new EventLog(db);
    const a = upsertGoogleAccount(db, { subject: "sub-a", email: "a@example.com" }).id;
    setSourceEnabled(db, a, "gmail", false);
    const accepted = await handleWorkflowRequest(
      new Request("https://local/api/workflows", {
        method: "POST",
        body: JSON.stringify({
          title: "자료 수집",
          instruction: "켜진 정보를 모읍니다",
          executor: {
            kind: "script",
            path: "jobs/collection.ts",
            args: [a],
            capabilities: ["account.read"],
          },
          timeoutSeconds: 60,
        }),
      }),
      { db, events },
    );
    ok(accepted, "workflow route matched");
    expect(accepted.status).toBe(201);
    const row = db
      .query<{ executor_json: string }, [string]>(
        "SELECT executor_json FROM workflows WHERE json_extract(executor_json,'$.args[0]') = ?",
      )
      .get(a);
    expect(row === null ? {} : JSON.parse(row.executor_json)).toEqual({
      kind: "script",
      path: "jobs/collection.ts",
      args: [a],
      capabilities: ["account.read"],
    });
  });

  test("connecting an account grants use and never starts a collection", async () => {
    const db = fresh();
    const events = new EventLog(db);
    const calls: string[] = [];
    const deps = routeDeps(googleDeps(db, events, calendarAndMailFetch(calls)));
    const before = db
      .query<{ n: number }, SQLQueryBindings[]>("SELECT count(*) AS n FROM sync_items")
      .get();

    const body = AccountsBody.parse(
      await (await handleAccountRequest(new Request("https://local/api/accounts"), deps))?.json(),
    );
    expect(body.accounts.map((account) => account.connected)).toEqual([false, false]);
    expect(calls).toEqual([]);
    const after = db
      .query<{ n: number }, SQLQueryBindings[]>("SELECT count(*) AS n FROM sync_items")
      .get();
    expect(after).toEqual(before);

    const manual = await handleAccountRequest(
      new Request(`https://local/api/accounts/${DEFAULT_GOOGLE_ACCOUNT_ID}/sync`, {
        method: "POST",
      }),
      deps,
    );
    // The route is gone: "/api/accounts/<id>/sync" matches no handler.
    expect(manual).toBeNull();
  });

  test("authUrl asks for openid and email so identity is verifiable", () => {
    const url = new URL(authUrl(config, "state-value"));
    expect(url.searchParams.get("scope")).toContain("openid");
    expect(url.searchParams.get("scope")).toContain("email");
    expect(url.searchParams.get("state")).toBe("state-value");
  });
});
