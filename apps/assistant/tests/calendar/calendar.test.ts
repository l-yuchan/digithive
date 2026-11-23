import assert from "node:assert/strict";
import { afterEach, test } from "bun:test";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { migrate, migrations } from "../../src/db/store";
import { SecretVault } from "../../src/server/secrets";
import { CalendarSyncError, queryFingerprint, syncCalendar, syncCursor } from "../../src/integrations/calendar";
import { expandSeries, listOccurrences, materializeOccurrences } from "../../src/knowledge/calendar-occurrences";
import type { GoogleConfig } from "../../src/integrations/google-auth";
import { storeConnection } from "../../src/integrations/google-auth";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const config: GoogleConfig = {
  clientId: "c", clientSecret: "s", redirectUri: "http://127.0.0.1:4317/cb",
  authUrl: "https://auth.example", tokenUrl: "https://token.example",
};

function fixture(): { db: Database; vault: SecretVault; connectionId: string } {
  const db = new Database(":memory:", { strict: true });
  migrate(db, migrations());
  databases.push(db);
  const vault = new SecretVault(Buffer.alloc(32, 3).toString("base64"));
  const connectionId = storeConnection(db, vault, "google", {
    access_token: "good", refresh_token: "refresh", expires_in: 100_000,
  }, 1000);
  return { db, vault, connectionId };
}

const master = {
  id: "series-1", summary: "주간 회의", status: "confirmed",
  start: { dateTime: "2026-11-03T09:00:00+09:00", timeZone: "Asia/Seoul" },
  end: { dateTime: "2026-11-03T10:00:00+09:00", timeZone: "Asia/Seoul" },
  recurrence: [
    "RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=8",
    "EXDATE;TZID=Asia/Seoul:20261117T090000",
  ],
};

const moved = {
  id: "series-1_20261124T000000Z", summary: "주간 회의 (이동)", status: "confirmed",
  recurringEventId: "series-1",
  originalStartTime: { dateTime: "2026-11-24T09:00:00+09:00" },
  start: { dateTime: "2026-11-24T14:00:00+09:00", timeZone: "Asia/Seoul" },
  end: { dateTime: "2026-11-24T15:00:00+09:00", timeZone: "Asia/Seoul" },
};

const cancelledInstance = {
  id: "series-1_20261201T000000Z", status: "cancelled", recurringEventId: "series-1",
  originalStartTime: { dateTime: "2026-12-01T09:00:00+09:00" },
  start: { dateTime: "2026-12-01T09:00:00+09:00", timeZone: "Asia/Seoul" },
  end: { dateTime: "2026-12-01T10:00:00+09:00", timeZone: "Asia/Seoul" },
};

const allDay = {
  id: "all-day-1", summary: "학회", status: "confirmed",
  start: { date: "2026-11-20" }, end: { date: "2026-11-21" },
};

test("a weekly series expands, honours EXDATE, moved and cancelled instances", () => {
  const window = { from: Date.parse("2026-11-01T00:00:00+09:00"), to: Date.parse("2027-01-01T00:00:00+09:00") };
  const occurrences = expandSeries(master, [moved, cancelledInstance], window);
  const starts = occurrences.map((occurrence) => occurrence.startsAt);
  assert.equal(starts.includes("2026-11-03T09:00:00+09:00"), true);
  assert.equal(starts.includes("2026-11-17T09:00:00+09:00"), false, "EXDATE must remove the occurrence");
  assert.equal(starts.includes("2026-11-24T14:00:00+09:00"), true, "moved instance keeps its new time");
  assert.equal(starts.includes("2026-11-24T09:00:00+09:00"), false, "moved instance must not double");
  assert.equal(occurrences.some((occurrence) => occurrence.cancelled), true);
});

test("a full sync stores versions once and the second sync with a token stores nothing new", async () => {
  const { db, vault, connectionId } = fixture();
  let calls = 0;
  const fetchFn = (async (input: URL | Request) => {
    calls += 1;
    const url = new URL(String(input));
    if (url.searchParams.get("syncToken")) {
      return Response.json({ items: [], nextSyncToken: "token-2" });
    }
    return Response.json({ items: [master, allDay], nextSyncToken: "token-1" });
  }) as unknown as typeof fetch;
  const source = { connectionId, calendarId: "primary", timeZone: "Asia/Seoul" };

  const first = await syncCalendar(db, vault, config, source, fetchFn, () => 2_000);
  assert.deepEqual({ inserted: first.inserted, full: first.full }, { inserted: 2, full: true });
  assert.match(syncCursor(db, source) ?? "", /^token-1$/);

  const second = await syncCalendar(db, vault, config, source, fetchFn, () => 3_000);
  assert.equal(second.inserted, 0);
  assert.equal(calls, 2);
  assert.match(syncCursor(db, source) ?? "", /^token-2$/);
});

test("a failed page leaves the previous snapshot and cursor in place", async () => {
  const { db, vault, connectionId } = fixture();
  let phase = 0;
  const fetchFn = (async () => {
    phase += 1;
    if (phase === 1) return Response.json({ items: [master], nextSyncToken: "token-1" });
    if (phase === 2) return Response.json({ items: [allDay], nextPageToken: "page-2" });
    return Response.json({ error: "boom" }, { status: 500 });
  }) as unknown as typeof fetch;
  const source = { connectionId, calendarId: "primary", timeZone: "Asia/Seoul" };
  await syncCalendar(db, vault, config, source, fetchFn, () => 2_000);
  const before = syncCursor(db, source);

  await assert.rejects(() => syncCalendar(db, vault, config, source, fetchFn, () => 3_000), CalendarSyncError);
  assert.equal(syncCursor(db, source), before);
  assert.equal(z.object({ n: z.number() }).parse(db.query("SELECT count(*) AS n FROM source_items").get()).n, 1);
});

test("a 410 forces a full resync of only that connection", async () => {
  const { db, vault, connectionId } = fixture();
  let seesSyncToken = false;
  const fetchFn = (async (input: URL | Request) => {
    const url = new URL(String(input));
    if (url.searchParams.get("syncToken")) {
      seesSyncToken = true;
      return Response.json({ error: "fullSyncRequired" }, { status: 410 });
    }
    return Response.json({ items: [allDay], nextSyncToken: "fresh-token" });
  }) as unknown as typeof fetch;
  const source = { connectionId, calendarId: "primary", timeZone: "Asia/Seoul" };
  db.query("UPDATE connections SET sync_cursor = ? WHERE id = ?")
    .run(`${queryFingerprint(source)}:stale-token`, connectionId);

  const result = await syncCalendar(db, vault, config, source, fetchFn, () => 2_000);
  assert.equal(seesSyncToken, true);
  assert.equal(result.full, true);
  assert.equal(z.object({ n: z.number() }).parse(db.query("SELECT count(*) AS n FROM source_items").get()).n, 1);
});

test("materialized window holds occurrences and excludes cancelled instances", async () => {
  const { db, vault, connectionId } = fixture();
  const fetchFn = (async () => Response.json({
    items: [master, moved, cancelledInstance, allDay], nextSyncToken: "t",
  })) as unknown as typeof fetch;
  const source = { connectionId, calendarId: "primary", timeZone: "Asia/Seoul" };
  await syncCalendar(db, vault, config, source, fetchFn, () => 2_000);
  const window = { from: Date.parse("2026-11-01T00:00:00+09:00"), to: Date.parse("2026-12-31T00:00:00+09:00") };
  const occurrences = materializeOccurrences(db, connectionId, window, () => 2_000);

  assert.equal(occurrences.some((occurrence) => occurrence.summary === "학회" && occurrence.allDay), true);
  const cancelled = occurrences.filter((occurrence) => occurrence.cancelled);
  assert.equal(cancelled.length, 1);
  const listed = listOccurrences(db, "2026-11-01T00:00:00+09:00", "2026-12-31T00:00:00+09:00");
  assert.equal(listed.length >= 5, true);
  const unique = new Set(listed.map((occurrence) => occurrence.startsAt));
  assert.equal(unique.size, listed.length, "no duplicate occurrence instants");
});
