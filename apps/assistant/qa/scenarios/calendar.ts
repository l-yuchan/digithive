import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { storeConnection, type GoogleConfig } from "../../src/integrations/google-auth";
import { CalendarSyncError, syncCalendar, syncCursor } from "../../src/integrations/calendar";
import { listOccurrences, materializeOccurrences } from "../../src/knowledge/calendar-occurrences";
import type { SecretVault } from "../../src/server/secrets";

type CalendarContext = {
  readonly db: Database;
  readonly vault: SecretVault;
  readonly evidence: string;
  readonly fixtureBase: string;
};

type PageSpec = { status: number; body: unknown };
let pages: PageSpec[] = [];
const requests: { path: string; syncToken: string | null; pageToken: string | null }[] = [];

export function setCalendarPages(specs: readonly PageSpec[]): void {
  pages = [...specs];
  requests.length = 0;
}

export async function calendarFetch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  requests.push({
    path: url.pathname,
    syncToken: url.searchParams.get("syncToken"),
    pageToken: url.searchParams.get("pageToken"),
  });
  const page = pages.shift() ?? { status: 200, body: { items: [] } };
  return Response.json(page.body, { status: page.status });
}

const config: GoogleConfig = {
  clientId: "c", clientSecret: "s", redirectUri: "http://127.0.0.1:4317/cb",
  authUrl: "https://auth.example", tokenUrl: `${"http://127.0.0.1:4318"}/oauth/token`,
};

const master = {
  id: "series-1", summary: "주간 회의", status: "confirmed",
  start: { dateTime: "2026-11-03T09:00:00+09:00", timeZone: "Asia/Seoul" },
  end: { dateTime: "2026-11-03T10:00:00+09:00", timeZone: "Asia/Seoul" },
  recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=8", "EXDATE;TZID=Asia/Seoul:20261117T090000"],
};
const moved = {
  id: "series-1_20261124", summary: "주간 회의 (오후로 이동)", status: "confirmed",
  recurringEventId: "series-1", originalStartTime: { dateTime: "2026-11-24T09:00:00+09:00" },
  start: { dateTime: "2026-11-24T14:00:00+09:00", timeZone: "Asia/Seoul" },
  end: { dateTime: "2026-11-24T15:00:00+09:00", timeZone: "Asia/Seoul" },
};
const allDay = { id: "all-day", summary: "학회 발표", status: "confirmed", start: { date: "2026-11-20" }, end: { date: "2026-11-21" } };

function connection(context: CalendarContext): { db: Database; source: { connectionId: string; calendarId: string; timeZone: string } } {
  const connectionId = storeConnection(context.db, context.vault, "google", {
    access_token: "calendar-token", refresh_token: "refresh", expires_in: 100_000,
  }, Date.now());
  return { db: context.db, source: { connectionId, calendarId: "primary", timeZone: "Asia/Seoul" } };
}

export async function calendarSyncRecurrence(context: CalendarContext): Promise<void> {
  process.env["GOOGLE_CALENDAR_BASE"] = context.fixtureBase;
  const { db, source } = connection(context);
  setCalendarPages([
    { status: 200, body: { items: [master, moved], nextPageToken: "page-2" } },
    { status: 200, body: { items: [allDay], nextSyncToken: "sync-1" } },
  ]);

  const first = await syncCalendar(db, context.vault, config, source, fetch, () => Date.parse("2026-11-01T00:00:00Z"));
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.syncToken, null);
  assert.equal(requests[1]?.pageToken, "page-2");
  assert.equal(first.inserted, 3);

  const window = { from: Date.parse("2026-11-01T00:00:00+09:00"), to: Date.parse("2026-12-31T00:00:00+09:00") };
  const occurrences = materializeOccurrences(db, source.connectionId, window, () => Date.parse("2026-11-01T00:00:00Z"));
  const starts = occurrences.map((occurrence) => occurrence.startsAt);
  assert.equal(starts.includes("2026-11-24T14:00:00+09:00"), true, "moved instance must appear at its new time");
  assert.equal(starts.includes("2026-11-24T09:00:00+09:00"), false, "moved instance must not appear twice");
  assert.equal(starts.includes("2026-11-17T09:00:00+09:00"), false, "EXDATE must remove the occurrence");
  assert.equal(starts.includes("2026-11-20T00:00:00+00:00"), true, "all-day event must appear");
  assert.equal(new Set(starts).size, starts.length);

  setCalendarPages([{ status: 200, body: { items: [], nextSyncToken: "sync-2" } }]);
  const second = await syncCalendar(db, context.vault, config, source, fetch, () => Date.parse("2026-11-01T01:00:00Z"));
  assert.equal(second.inserted, 0);
  assert.equal(requests[0]?.syncToken, "sync-1", "incremental sync must send the stored token");

  await writeFile(join(context.evidence, "http.json"), `${JSON.stringify({
    firstSync: { pages: 2, inserted: first.inserted, full: first.full },
    secondSync: { inserted: second.inserted, sentSyncToken: "sync-1" },
    requests,
  }, null, 2)}\n`);
  await writeFile(join(context.evidence, "occurrences.json"), `${JSON.stringify({
    window: { from: "2026-11-01", to: "2026-12-31" }, count: occurrences.length,
    sample: occurrences.slice(0, 6).map((occurrence) => ({
      summary: occurrence.summary, startsAt: occurrence.startsAt, allDay: occurrence.allDay,
      overridden: occurrence.overridden, cancelled: occurrence.cancelled,
    })),
    movedInstanceCount: starts.filter((value) => value.startsWith("2026-11-24")).length,
  }, null, 2)}\n`);
}

export async function calendar410PageFailure(context: CalendarContext): Promise<void> {
  process.env["GOOGLE_CALENDAR_BASE"] = context.fixtureBase;
  const { db, source } = connection(context);
  setCalendarPages([{ status: 200, body: { items: [master, allDay], nextSyncToken: "sync-1" } }]);
  await syncCalendar(db, context.vault, config, source, fetch, () => Date.parse("2026-11-01T00:00:00Z"));
  materializeOccurrences(db, source.connectionId, {
    from: Date.parse("2026-11-01T00:00:00+09:00"), to: Date.parse("2026-12-31T00:00:00+09:00"),
  }, () => Date.parse("2026-11-01T00:00:00Z"));
  const beforeItems = z.object({ n: z.number() }).parse(db.query("SELECT count(*) AS n FROM source_items").get()).n;
  const beforeCursor = syncCursor(db, source);
  assert.equal(beforeCursor, "sync-1");

  setCalendarPages([{ status: 410, body: { error: "fullSyncRequired" } }]);
  await assert.rejects(() => syncCalendar(db, context.vault, config, source, fetch, () => Date.parse("2026-11-01T01:00:00Z")), CalendarSyncError);
  assert.equal(syncCursor(db, source), beforeCursor);
  assert.equal(z.object({ n: z.number() }).parse(db.query("SELECT count(*) AS n FROM source_items").get()).n, beforeItems);

  setCalendarPages([
    { status: 200, body: { items: [master], nextPageToken: "page-2" } },
    { status: 500, body: { error: "backend" } },
  ]);
  await assert.rejects(() => syncCalendar(db, context.vault, config, source, fetch, () => Date.parse("2026-11-01T02:00:00Z")));
  assert.equal(syncCursor(db, source), beforeCursor, "a failed page must not advance the cursor");
  db.query("UPDATE connections SET sync_status = 'stale' WHERE id = ?").run(source.connectionId);

  const occurrencesBefore = listOccurrences(db, "2026-11-01T00:00:00+09:00", "2026-12-31T00:00:00+09:00").length;
  assert.equal(occurrencesBefore > 0, true, "previous snapshot stays readable");

  await writeFile(join(context.evidence, "db-diff.json"), `${JSON.stringify({
    previousCursor: beforeCursor, cursorAfter410: syncCursor(db, source),
    itemsBefore: beforeItems, itemsAfter: beforeItems,
    occurrencesPreserved: occurrencesBefore, staleMarker: "stale",
  }, null, 2)}\n`);
}
