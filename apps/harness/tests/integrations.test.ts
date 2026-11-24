import { ok } from "node:assert/strict";
import { describe, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { migrate } from "../src/store/db";
import { EventLog } from "../src/events/log";
import { open, seal } from "../src/core/vault";
import { exchangeCode, refreshTokens, saveTokens, syncGoogleCalendar, syncGoogleGmail, type GoogleDeps } from "../src/integrations/google";
import { syncCanvas } from "../src/integrations/canvas";
import { composeBriefing, dueSlot, runBriefing, storeBriefing, latestBriefing } from "../src/scheduler/compose";
import { addSubscription, sendPush } from "../src/scheduler/push";

function db(): Database {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  migrate(database);
  return database;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const config = { clientId: "cid", clientSecret: "csecret", redirectUri: "https://x/api/oauth/google/callback" };

describe("vault", () => {
  test("sealed values round-trip and a different secret cannot open them", () => {
    const sealed = seal("secret-a", JSON.stringify({ token: "abc" }));
    expect(open("secret-a", sealed)).toBe(JSON.stringify({ token: "abc" }));
    expect(open("secret-b", sealed)).toBeNull();
    expect(open("secret-a", "garbage")).toBeNull();
  });
});

describe("google oauth + sync", () => {
  test("code exchange and refresh parse tokens, refresh keeps the refresh token", async () => {
    const fetchImpl = Object.assign((async () => jsonResponse({ access_token: "at1", refresh_token: "rt1", expires_in: 3600, scope: "s" })), { preconnect: fetch.preconnect });
    const tokens = await exchangeCode(config, "code", fetchImpl, 1_000);
    expect(tokens).toMatchObject({ accessToken: "at1", refreshToken: "rt1", expiresAt: 1_000 + 3_600_000 });

    const refreshFetch = Object.assign((async () => jsonResponse({ access_token: "at2", expires_in: 60 })), { preconnect: fetch.preconnect });
    const refreshed = await refreshTokens(config, "rt1", refreshFetch, 2_000);
    expect(refreshed.accessToken).toBe("at2");
    expect(refreshed.refreshToken).toBe("rt1");
  });

  function googleDeps(fetchImpl: typeof fetch, now = 10_000_000): GoogleDeps {
    const database = db();
    const events = new EventLog(database);
    saveTokens(database, "vault", { accessToken: "at", refreshToken: "rt", expiresAt: now + 3_600_000, scope: "s" });
    return { db: database, events, config, vaultSecret: "vault", fetchImpl, now: () => now };
  }

  test("calendar sync stores items and its own syncToken cursor", async () => {
    const calls: string[] = [];
    const fetchImpl = Object.assign((async (input: string | URL | Request) => {
      calls.push((input instanceof Request ? input.url : input.toString()));
      return jsonResponse({ items: [{ id: "e1", summary: "회의", start: { dateTime: "2026-11-24T10:00:00+09:00" } }], nextSyncToken: "st-1" });
    }), { preconnect: fetch.preconnect });
    const deps = googleDeps(fetchImpl);
    const outcome = await syncGoogleCalendar(deps);
    expect(outcome).toMatchObject({ ok: true, count: 1, cursor: "st-1" });
    const item = deps.db.query<{ title: string; at: string }, SQLQueryBindings[]>("SELECT title, at FROM sync_items WHERE source = 'calendar'").get();
    ok(item, "fixture row exists");
    expect(item).toEqual({ title: "회의", at: "2026-11-24T10:00:00+09:00" });
    const state = deps.db.query<{ cursor: string; ok: number }, SQLQueryBindings[]>("SELECT cursor, ok FROM integration_state WHERE source = 'calendar'").get();
    ok(state, "fixture row exists");
    expect(state).toEqual({ cursor: "st-1", ok: 1 });

    // the next sync must send the stored cursor
    await syncGoogleCalendar(deps);
    expect(calls.at(-1)).toContain("syncToken=st-1");
  });

  test("the incremental calendar request carries the syncToken and no timeMin", async () => {
    const calls: string[] = [];
    const deps = googleDeps(Object.assign((async (input: string | URL | Request) => {
      calls.push(decodeURIComponent((input instanceof Request ? input.url : input.toString())));
      return jsonResponse({ items: [], nextSyncToken: "st-next" });
    }), { preconnect: fetch.preconnect }));
    deps.db.query("INSERT INTO integration_state (source, cursor, ok) VALUES ('calendar','st-old',1)").run();
    const outcome = await syncGoogleCalendar(deps);
    expect(outcome.ok).toBe(true);
    expect(calls[0]).toContain("syncToken=st-old");
    expect(calls[0]).not.toContain("timeMin=");
    expect(calls[0]).not.toContain("singleEvents=");
  });

  test("a 400 on the incremental request restarts with a full sync", async () => {
    const calls: string[] = [];
    const deps = googleDeps(Object.assign((async (input: string | URL | Request) => {
      const url = decodeURIComponent((input instanceof Request ? input.url : input.toString()));
      calls.push(url);
      if (url.includes("syncToken=")) return jsonResponse({ error: "bad token" }, 400);
      return jsonResponse({ items: [], nextSyncToken: "st-fresh" });
    }), { preconnect: fetch.preconnect }));
    deps.db.query("INSERT INTO integration_state (source, cursor, ok) VALUES ('calendar','st-bad',1)").run();
    const outcome = await syncGoogleCalendar(deps);
    expect(outcome).toMatchObject({ ok: true, error: "full_resync_after_400", cursor: "st-fresh" });
    expect(calls[1]).not.toContain("syncToken=");
    expect(calls[1]).toContain("timeMin=");
  });

  test("calendar 410 falls back to a full resync without the cursor", async () => {
    const deps = googleDeps(Object.assign((async (input: string | URL | Request) => {
      if ((input instanceof Request ? input.url : input.toString()).includes("syncToken=")) return jsonResponse({ error: "expired" }, 410);
      return jsonResponse({ items: [], nextSyncToken: "st-2" });
    }), { preconnect: fetch.preconnect }));
    const first = await syncGoogleCalendar(deps);
    expect(first.ok).toBe(true);
    // seed a cursor, then force the 410 path
    deps.db.query("UPDATE integration_state SET cursor = 'old' WHERE source = 'calendar'").run();
    const second = await syncGoogleCalendar(deps);
    expect(second).toMatchObject({ ok: true, error: "full_resync_after_410", cursor: "st-2" });
  });

  test("gmail 404 on historyId falls back to the full list and stores a fresh historyId", async () => {
    const deps = googleDeps(Object.assign((async (input: string | URL | Request) => {
      const url = (input instanceof Request ? input.url : input.toString());
      if (url.includes("/history")) return jsonResponse({ error: "not found" }, 404);
      if (url.endsWith("/profile")) return jsonResponse({ historyId: "h-9" });
      if (url.includes("/messages?")) return jsonResponse({ messages: [{ id: "m1" }] });
      return jsonResponse({ id: "m1", internalDate: "1795500000000", payload: { headers: [{ name: "Subject", value: "안내" }] } });
    }), { preconnect: fetch.preconnect }));
    deps.db.query("INSERT INTO integration_state (source, cursor, ok) VALUES ('gmail', 'old-history', 1)").run();
    const outcome = await syncGoogleGmail(deps);
    expect(outcome).toMatchObject({ ok: true, cursor: "h-9", error: "full_resync" });
    expect(outcome.count).toBe(1);
  });

  test("calendar and gmail keep independent cursors", async () => {
    const deps = googleDeps(Object.assign((async (input: string | URL | Request) => {
      const url = (input instanceof Request ? input.url : input.toString());
      if (url.includes("calendar")) return jsonResponse({ items: [], nextSyncToken: "cal-1" });
      if (url.includes("/history")) return jsonResponse({ history: [], historyId: "mail-1" });
      return jsonResponse({});
    }), { preconnect: fetch.preconnect }));
    deps.db.query("INSERT INTO integration_state (source, cursor, ok) VALUES ('gmail','mail-0',1)").run();
    await syncGoogleCalendar(deps);
    await syncGoogleGmail(deps);
    const rows = deps.db.query<{ source: string; cursor: string }, SQLQueryBindings[]>("SELECT source, cursor FROM integration_state ORDER BY source").all();
    expect(rows).toEqual([
      { source: "calendar", cursor: "cal-1" },
      { source: "gmail", cursor: "mail-1" },
    ]);
  });
});

describe("canvas", () => {
  test("todos normalize and sort by due date", async () => {
    const database = db();
    const events = new EventLog(database);
    const outcome = await syncCanvas({
      db: database,
      events,
      config: { baseUrl: "https://lxp.example", token: "t" },
      fetchImpl: Object.assign((async () =>
        jsonResponse([
          { assignment: { id: 2, name: "보고서", due_at: "2026-11-30T14:59:00Z", course_id: 1 }, context_name: "과목 A" },
          { assignment: { id: 1, name: "퀴즈", due_at: "2026-11-25T14:59:00Z", course_id: 1 }, context_name: "과목 A" },
        ])), { preconnect: fetch.preconnect }),
    });
    expect(outcome).toMatchObject({ ok: true, count: 2 });
    const ids = database.query<{ item_id: string }, SQLQueryBindings[]>("SELECT item_id FROM sync_items WHERE source = 'canvas' ORDER BY at").all();
    expect(ids.map((row) => row.item_id)).toEqual(["1", "2"]);
  });

  test("a failing response is a visible failure, not an empty success", async () => {
    const database = db();
    const events = new EventLog(database);
    const outcome = await syncCanvas({
      db: database,
      events,
      config: { baseUrl: "https://lxp.example", token: "t" },
      fetchImpl: Object.assign((async () => jsonResponse({ error: "unauthorized" }, 401)), { preconnect: fetch.preconnect }),
    });
    expect(outcome).toMatchObject({ ok: false, error: "canvas_http_401" });
  });
});

describe("briefing schedule and composition", () => {
  const now = Date.parse("2026-11-24T07:30:30+09:00");

  test("dueSlot matches only inside the slot window", () => {
    expect(dueSlot(Date.parse("2026-11-24T07:30:30+09:00"))).toEqual({ slot: "07:30", day: "2026-11-24" });
    expect(dueSlot(Date.parse("2026-11-24T07:45:00+09:00"))).toBeNull();
    expect(dueSlot(Date.parse("2026-11-24T21:00:05+09:00"))).toEqual({ slot: "21:00", day: "2026-11-24" });
    expect(dueSlot(Date.parse("2026-11-24T12:00:00+09:00"))).toBeNull();
  });

  test("composition lists items with source ids and stores once per slot", async () => {
    const database = db();
    const events = new EventLog(database);
    database.query("INSERT INTO sync_items (source,item_id,title,at,detail,url,updated_at) VALUES ('calendar','e1','팀 회의','2026-11-24T11:00:00Z','',NULL,'x')").run();
    database.query("INSERT INTO sync_items (source,item_id,title,at,detail,url,updated_at) VALUES ('canvas','a1','보고서','2026-11-25T00:00:00Z','과목 A',NULL,'x')").run();

    const content = composeBriefing(database, now, 36, "07:30");
    expect(content.text).toContain("[calendar:e1]");
    expect(content.text).toContain("[lms:a1]");

    const first = storeBriefing(database, content, now);
    const second = storeBriefing(database, content, now);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(latestBriefing(database)?.slot).toBe("07:30");

    const run = await runBriefing({ db: database, events, now: () => now });
    expect(run).toMatchObject({ slot: "07:30", stored: false });
  });

  test("a push failure is reported, a success marks delivery", async () => {
    const database = db();
    addSubscription(database, { endpoint: "https://push.example/1", keys: { p256dh: "a", auth: "b" } });
    const failing = await sendPush(database, { publicKey: "p", privateKey: "s", subject: "mailto:x@y" }, { title: "t", body: "b" }, async () => {
      throw new Error("410 gone");
    });
    expect(failing.failed).toBe(1);
    expect(failing.errors[0]).toContain("410 gone");
    expect(database.query("SELECT count(*) n FROM push_subscriptions").get()).toEqual({ n: 0 });

    addSubscription(database, { endpoint: "https://push.example/2", keys: { p256dh: "a", auth: "b" } });
    const delivered = await sendPush(database, { publicKey: "p", privateKey: "s", subject: "mailto:x@y" }, { title: "t", body: "b" }, async () => undefined);
    expect(delivered.sent).toBe(1);
    const row = database.query<{ last_success_at: string }, SQLQueryBindings[]>("SELECT last_success_at FROM push_subscriptions").get();
    ok(row, "fixture row exists");
    expect(row.last_success_at).not.toBeNull();
  });
});
