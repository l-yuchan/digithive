import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { openDatabase } from "../../src/server/db";
import { Store } from "../../src/server/store";
import { createApi } from "../../src/server/api";
import { parseCalendar, parseCalendarUrl } from "../../src/server/calendar";
import type { CalendarDocument } from "../../src/server/calendar";

// Subscribed iCal calendars: recurrence expansion, occurrence diffing on
// repeated syncs, and the read-only agenda the person actually sees.

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const FEED = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//digithive test//EN
BEGIN:VTIMEZONE
TZID:Asia/Seoul
BEGIN:STANDARD
DTSTART:19700101T000000
TZOFFSETFROM:+0900
TZOFFSETTO:+0900
TZNAME:KST
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:weekly-1
DTSTAMP:20260101T000000Z
DTSTART;TZID=Asia/Seoul:20261103T100000
DTEND;TZID=Asia/Seoul:20261103T110000
SUMMARY:주간 회의
RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=6
EXDATE;TZID=Asia/Seoul:20261117T100000
END:VEVENT
BEGIN:VEVENT
UID:weekly-1
RECURRENCE-ID;TZID=Asia/Seoul:20261124T100000
DTSTAMP:20260101T000000Z
DTSTART;TZID=Asia/Seoul:20261124T140000
DTEND;TZID=Asia/Seoul:20261124T150000
SUMMARY:주간 회의 (시간 변경)
END:VEVENT
BEGIN:VEVENT
UID:workshop
DTSTAMP:20260101T000000Z
DTSTART;VALUE=DATE:20261110
DTEND;VALUE=DATE:20261112
SUMMARY:워크숍
END:VEVENT
END:VCALENDAR`;

const window = { timeZone: "Asia/Seoul", from: new Date("2026-11-01T00:00:00Z"), to: new Date("2027-03-01T00:00:00Z") };

describe("iCal expansion", () => {
  test("weekly rule honors EXDATE and a moved RECURRENCE-ID without duplicating the slot", () => {
    const occurrences = parseCalendar(FEED, window);
    const meeting = occurrences.filter((o) => o.uid === "weekly-1");
    expect(meeting.map((o) => [o.starts_at, o.summary])).toEqual([
      ["2026-11-03T01:00:00.000Z", "주간 회의"],
      ["2026-11-10T01:00:00.000Z", "주간 회의"],
      ["2026-12-01T01:00:00.000Z", "주간 회의"],
      ["2026-12-08T01:00:00.000Z", "주간 회의"],
      ["2026-11-24T05:00:00.000Z", "주간 회의 (시간 변경)"],
    ]);
    expect(meeting.find((o) => o.starts_at === "2026-11-24T05:00:00.000Z")?.ends_at).toBe("2026-11-24T06:00:00.000Z");
  });

  test("multi-day all-day events keep their date span at local midnight", () => {
    const event = parseCalendar(FEED, window).find((o) => o.uid === "workshop");
    expect(event).toMatchObject({
      all_day: true,
      starts_at: "2026-11-09T15:00:00.000Z",
      ends_at: "2026-11-11T15:00:00.000Z",
    });
  });

  test("a floating time is read in the app timezone, not as UTC", () => {
    const floating = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:floating-1
DTSTAMP:20260101T000000Z
DTSTART:20261120T090000
DTEND:20261120T100000
SUMMARY:진료 예약
END:VEVENT
END:VCALENDAR`;
    const [event] = parseCalendar(floating, window);
    expect(event?.starts_at).toBe("2026-11-20T00:00:00.000Z");
  });

  test("cancelled events are dropped rather than shown", () => {
    const cancelled = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:cancelled-1
DTSTAMP:20260101T000000Z
DTSTART:20261120T090000Z
DTEND:20261120T100000Z
SUMMARY:취소된 일정
STATUS:CANCELLED
END:VEVENT
END:VCALENDAR`;
    expect(parseCalendar(cancelled, window)).toEqual([]);
  });
});

describe("subscription URLs", () => {
  test.each(["file:///etc/passwd", "javascript:alert(1)", "http://169.254.169.254/latest/meta-data/"])(
    "rejects %s",
    (url) => {
      expect(() => parseCalendarUrl(url)).toThrow();
    },
  );
  test("accepts a normal https feed", () => {
    expect(parseCalendarUrl("https://calendar.example.com/private/basic.ics").hostname).toBe("calendar.example.com");
  });
});

function fixture(feed: { text: string } = { text: FEED }) {
  const db = openDatabase(":memory:");
  databases.push(db);
  const store = new Store(db);
  let clock = new Date("2026-11-01T00:00:00Z");
  const fetched: string[] = [];
  const api = createApi({
    store,
    now: () => clock,
    backupDir: "backups/test",
    fetchCalendar: async (url: string): Promise<CalendarDocument> => {
      fetched.push(url);
      return { text: feed.text, contentType: "text/calendar" };
    },
  });
  return {
    store,
    fetchFeed: (text: string) => { feed.text = text; },
    fetched,
    time: (value: string) => { clock = new Date(value); },
    call: async (path: string, method = "GET", body?: unknown) => {
      const response = await api.handle(new Request(`http://localhost/api${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) }));
      const result: unknown = await response.json();
      expect(response.status).toBeLessThan(400);
      return result;
    },
  };
}

const calendarList = z.object({
  calendars: z.array(z.object({ id: z.string(), name: z.string(), enabled: z.boolean(), event_count: z.number(), last_error: z.string().nullable(), last_synced_at: z.string().nullable() })),
  total: z.number(),
});
const eventsResult = z.object({
  events: z.array(z.object({ id: z.string(), calendar_id: z.string(), summary: z.string(), starts_at: z.string(), all_day: z.boolean() })),
  calendars: z.array(z.object({ id: z.string(), name: z.string() })),
});

async function subscribe(f: ReturnType<typeof fixture>, name = "개인 일정") {
  await f.call("/settings", "PATCH", { timezone: "Asia/Seoul" });
  const created = z.object({
    calendar: z.object({ id: z.string() }),
    sync: z.object({ added: z.number(), total: z.number() }).nullable(),
  }).parse(await f.call("/calendars", "POST", { name, url: "https://calendar.example.com/private.ics" }));
  return created.calendar;
}

test("a subscription syncs immediately and a second sync changes nothing", async () => {
  const f = fixture();
  const calendar = await subscribe(f);
  const first = eventsResult.parse(await f.call("/calendar/events?days=60")).events.filter((e) => e.calendar_id === calendar.id);
  expect(first).toHaveLength(6); // five weekly meetings plus one all-day workshop
  expect(first.filter((e) => e.all_day)).toHaveLength(1);

  const again = z.object({ sync: z.object({ added: z.number(), updated: z.number(), removed: z.number(), total: z.number() }) })
    .parse(await f.call(`/calendars/${calendar.id}/sync`, "POST"));
  expect(again.sync).toEqual({ added: 0, updated: 0, removed: 0, total: 6 });
  expect(f.fetched).toHaveLength(2);
});

test("an event removed from the feed leaves the agenda on the next sync", async () => {
  const f = fixture();
  const calendar = await subscribe(f);
  f.fetchFeed(FEED.replace(/BEGIN:VEVENT\nUID:workshop[\s\S]*?END:VEVENT\n/, ""));
  const result = z.object({ sync: z.object({ added: z.number(), updated: z.number(), removed: z.number(), total: z.number() }) })
    .parse(await f.call(`/calendars/${calendar.id}/sync`, "POST"));
  expect(result.sync).toEqual({ added: 0, updated: 0, removed: 1, total: 5 });
  const events = eventsResult.parse(await f.call("/calendar/events?days=60")).events;
  expect(events.some((e) => e.summary === "워크숍")).toBe(false);
});

test("a disabled subscription stays out of the agenda but keeps its rows", async () => {
  const f = fixture();
  const calendar = await subscribe(f);
  const patched = z.object({ calendar: z.object({ enabled: z.boolean(), event_count: z.number() }) })
    .parse(await f.call(`/calendars/${calendar.id}`, "PATCH", { enabled: false }));
  expect(patched.calendar).toMatchObject({ enabled: false, event_count: 6 });
  expect(eventsResult.parse(await f.call("/calendar/events")).events).toEqual([]);
  await f.call(`/calendars/${calendar.id}`, "PATCH", { enabled: true });
  expect(eventsResult.parse(await f.call("/calendar/events?days=60")).events).toHaveLength(6);
});

test("a failing feed keeps the subscription and surfaces the reason", async () => {
  const f = fixture();
  const db = openDatabase(":memory:");
  databases.push(db);
  const store = new Store(db);
  const api = createApi({
    store,
    now: () => new Date("2026-11-01T00:00:00Z"),
    backupDir: "backups/test",
    fetchCalendar: async () => { throw new Error("구독 주소가 HTTP 404로 응답했습니다."); },
  });
  const response = await api.handle(new Request("http://localhost/api/calendars", { method: "POST", body: JSON.stringify({ name: "깨진 구독", url: "https://calendar.example.com/missing.ics" }), headers: { "content-type": "application/json" } }));
  const body = z.object({ calendar: z.object({ last_error: z.string().nullable(), event_count: z.number() }), sync_error: z.string().nullable() }).parse(await response.json());
  expect(response.status).toBe(201);
  expect(body.calendar.last_error).toContain("HTTP 404");
  expect(body.sync_error).toContain("HTTP 404");
  expect(body.calendar.event_count).toBe(0);
});

test("removing a subscription removes its occurrences and survives export and wipe", async () => {
  const f = fixture();
  const calendar = await subscribe(f);
  const bundle = z.object({ calendars: z.array(z.unknown()), calendar_events: z.array(z.unknown()) })
    .parse(await f.call("/backup/export"));
  expect(bundle.calendars).toHaveLength(1);
  expect(bundle.calendar_events).toHaveLength(6);

  await f.call(`/calendars/${calendar.id}`, "DELETE");
  expect(calendarList.parse(await f.call("/calendars")).total).toBe(0);
  expect(f.store.count("calendar_events")).toBe(0);

  await subscribe(f, "다시 추가");
  await f.call("/data/all", "DELETE", { confirm: "DELETE_ALL" });
  expect(f.store.count("calendars")).toBe(0);
  expect(f.store.count("calendar_events")).toBe(0);
});
