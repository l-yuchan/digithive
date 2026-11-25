import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../src/store/db";
import { EventLog } from "../src/events/log";
import { saveTokens, syncGoogleCalendar, syncGoogleGmail } from "../src/integrations/google";
import { z } from "zod";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function setup(respond: (url: URL, init?: Parameters<typeof fetch>[1]) => Response) {
  const db = new Database(":memory:");
  databases.push(db);
  migrate(db);
  const now = 1_000_000;
  saveTokens(db, "secret", {
    accessToken: "at",
    refreshToken: "rt",
    expiresAt: now + 3600_000,
    scope: null,
  });
  const fetchImpl: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      respond(new URL(input instanceof Request ? input.url : input.toString()), init),
    { preconnect: fetch.preconnect },
  );
  return {
    db,
    events: new EventLog(db),
    vaultSecret: "secret",
    config: { clientId: "id", clientSecret: "secret", redirectUri: "https://local/callback" },
    now: () => now,
    fetchImpl,
  };
}
function seed(db: Database, source: string, cursor: string) {
  db.query("INSERT INTO integration_state(source,cursor,ok) VALUES (?,?,1)").run(source, cursor);
  db.query(
    "INSERT INTO sync_items(source,item_id,title,detail,updated_at) VALUES (?,'old','old','','x')",
  ).run(source);
}

test("calendar commits all pages and removes cancelled events before advancing its cursor", async () => {
  const deps = setup((url) =>
    url.searchParams.has("pageToken")
      ? json({
          items: [
            { id: "old", status: "cancelled" },
            { id: "second", summary: "page two" },
          ],
          nextSyncToken: "next",
        })
      : json({ items: [{ id: "first", summary: "page one" }], nextPageToken: "p2" }),
  );
  seed(deps.db, "calendar", "previous");
  expect(await syncGoogleCalendar(deps)).toMatchObject({ ok: true, cursor: "next" });
  expect(deps.db.query("SELECT item_id FROM sync_items ORDER BY item_id").all()).toEqual([
    { item_id: "first" },
    { item_id: "second" },
  ]);
});

test("a failing later calendar page preserves the previous snapshot and cursor", async () => {
  const deps = setup((url) =>
    url.searchParams.has("pageToken")
      ? json({ error: "quota" }, 403)
      : json({ items: [{ id: "new", summary: "partial" }], nextPageToken: "p2" }),
  );
  seed(deps.db, "calendar", "previous");
  deps.db.query("UPDATE integration_state SET last_sync_at='2026-11-24T00:00:00.000Z'").run();
  expect((await syncGoogleCalendar(deps)).ok).toBe(false);
  expect(deps.db.query("SELECT cursor,ok FROM integration_state").get()).toEqual({
    cursor: "previous",
    ok: 0,
  });
  expect(deps.db.query("SELECT item_id FROM sync_items").all()).toEqual([{ item_id: "old" }]);
  expect(deps.db.query("SELECT last_sync_at FROM integration_state").get()).toEqual({
    last_sync_at: "2026-11-24T00:00:00.000Z",
  });
  expect(deps.events.after(0).at(-1)?.payload).toMatchObject({
    source: "calendar",
    ok: false,
    error: "calendar_http_403",
  });
});

test("expired Google credentials refresh before collection and the replacement is saved", async () => {
  let refreshes = 0;
  const deps = setup((url, init) => {
    if (url.pathname === "/token") {
      refreshes++;
      expect(z.instanceof(URLSearchParams).parse(init?.body).get("refresh_token")).toBe("rt");
      return json({ access_token: "new-access", expires_in: 3600 });
    }
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer new-access");
    return json({ items: [], nextSyncToken: "next" });
  });
  saveTokens(deps.db, "secret", {
    accessToken: "expired",
    refreshToken: "rt",
    expiresAt: 0,
    scope: null,
  });
  expect((await syncGoogleCalendar(deps)).ok).toBe(true);
  expect((await syncGoogleCalendar(deps)).ok).toBe(true);
  expect(refreshes).toBe(1);
});

test("full calendar resync replaces obsolete rows only when the replacement succeeds", async () => {
  const deps = setup((url) =>
    url.searchParams.has("syncToken")
      ? json({}, 410)
      : json({ items: [{ id: "new", summary: "replacement" }], nextSyncToken: "fresh" }),
  );
  seed(deps.db, "calendar", "expired");
  expect((await syncGoogleCalendar(deps)).ok).toBe(true);
  expect(deps.db.query("SELECT item_id FROM sync_items").all()).toEqual([{ item_id: "new" }]);
});

test("gmail consumes more than 25 additions across every history page", async () => {
  const deps = setup((url) => {
    if (url.pathname.endsWith("/history")) {
      if (url.searchParams.has("pageToken"))
        return json({
          history: [{ messagesAdded: [{ message: { id: "last" } }] }],
          historyId: "next",
        });
      return json({
        history: [
          { messagesAdded: Array.from({ length: 26 }, (_, i) => ({ message: { id: `m${i}` } })) },
        ],
        nextPageToken: "p2",
        historyId: "next",
      });
    }
    return json({ id: url.pathname.split("/").at(-1), snippet: "mail" });
  });
  seed(deps.db, "gmail", "previous");
  expect(await syncGoogleGmail(deps)).toMatchObject({ ok: true, cursor: "next", count: 27 });
  expect(deps.db.query("SELECT count(*) AS n FROM sync_items WHERE source='gmail'").get()).toEqual({
    n: 28,
  });
});

test("a failed gmail detail does not advance history or partially commit messages", async () => {
  const deps = setup((url) => {
    if (url.pathname.endsWith("/history"))
      return json({
        history: [{ messagesAdded: [{ message: { id: "ok" } }, { message: { id: "bad" } }] }],
        historyId: "next",
      });
    return url.pathname.endsWith("/bad") ? json({}, 500) : json({ id: "ok", snippet: "mail" });
  });
  seed(deps.db, "gmail", "previous");
  expect((await syncGoogleGmail(deps)).ok).toBe(false);
  expect(deps.db.query("SELECT cursor,ok FROM integration_state").get()).toEqual({
    cursor: "previous",
    ok: 0,
  });
  expect(deps.db.query("SELECT item_id FROM sync_items").all()).toEqual([{ item_id: "old" }]);
});

test("gmail full sync follows list pages and retains a cursor from before collection", async () => {
  let profileRead = false;
  const deps = setup((url) => {
    if (url.pathname.endsWith("/profile")) {
      profileRead = true;
      return json({ historyId: "baseline" });
    }
    if (url.pathname.endsWith("/messages")) {
      expect(profileRead).toBe(true);
      return url.searchParams.has("pageToken")
        ? json({ messages: [{ id: "b" }] })
        : json({ messages: [{ id: "a" }], nextPageToken: "p2" });
    }
    return json({ id: url.pathname.split("/").at(-1), snippet: "mail" });
  });
  expect(await syncGoogleGmail(deps)).toMatchObject({ ok: true, count: 2, cursor: "baseline" });
});
