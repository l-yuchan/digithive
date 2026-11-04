import type {
  CalendarColor,
  CalendarOccurrence,
  CalendarSubscription,
  CalendarSyncResult,
  Preference,
} from "../../shared";
import { createCalendarRequestSchema, updateCalendarRequestSchema } from "../../shared";
import type { Ctx, Route } from "../api_util";
import { badRequest, notFound, readBody } from "../api_util";
import {
  fetchCalendarDocument,
  parseCalendarUrl,
  occurrencesBetween,
  recordSyncFailure,
  syncCalendar,
} from "../calendar";
import type { CalendarEventRow, CalendarRow, Store } from "../store";
import { calendarEventView, calendarView, eq } from "../store";
import { groundedQuery } from "../retrieval";
import { deleteCalendar } from "../deletion";
import { localParts, zonedTimeToUtc } from "../time";

// Subscribed iCal calendars (contract §8). Feeds are read-only: the app never
// writes back to a calendar, never accepts invites, and never turns an
// occurrence into an entry without the person pressing the button.

const COLORS: readonly CalendarColor[] = ["accent", "info", "amber", "danger", "neutral"];

function fetcher(ctx: Ctx) {
  return ctx.fetchCalendar ?? fetchCalendarDocument;
}

function mustGetCalendar(store: Store, id: string | undefined): CalendarRow {
  const calendar = id ? store.byId<CalendarRow>("calendars", id) : null;
  if (!calendar) throw notFound(`calendar ${id ?? ""} not found`);
  return calendar;
}

function viewOf(store: Store, row: CalendarRow): CalendarSubscription {
  return calendarView(row, store.count("calendar_events", [eq("calendar_id", row.id)]));
}

function nextColor(store: Store): CalendarColor {
  return COLORS[store.count("calendars") % COLORS.length] ?? "accent";
}

async function syncOne(
  ctx: Ctx,
  calendar: CalendarRow,
): Promise<{ calendar: CalendarSubscription; sync: CalendarSyncResult | null; error: string | null }> {
  const settings = ctx.store.getSettings();
  try {
    const sync = await syncCalendar({
      store: ctx.store,
      calendar,
      fetchDocument: fetcher(ctx),
      now: ctx.now(),
      timeZone: settings.timezone,
    });
    return { calendar: viewOf(ctx.store, mustGetCalendar(ctx.store, calendar.id)), sync, error: null };
  } catch (error) {
    const message = recordSyncFailure(ctx.store, calendar, error, ctx.now());
    return { calendar: viewOf(ctx.store, mustGetCalendar(ctx.store, calendar.id)), sync: null, error: message };
  }
}

export const calendarRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/calendars",
    handler: async (ctx) => {
      const rows = ctx.store.list<CalendarRow>("calendars", [], { order: "created_at, id" });
      return { body: { calendars: rows.map((row) => viewOf(ctx.store, row)), total: rows.length } };
    },
  },
  {
    method: "POST",
    path: "/api/calendars",
    handler: async (ctx) => {
      const body = await readBody(ctx.req, createCalendarRequestSchema);
      const url = parseCalendarUrl(body.url);
      const nowIso = ctx.now().toISOString();
      const row: CalendarRow = {
        id: crypto.randomUUID(),
        name: body.name,
        url: url.toString(),
        color: body.color ?? nextColor(ctx.store),
        enabled: body.enabled === false ? 0 : 1,
        last_synced_at: null,
        last_error: null,
        created_at: nowIso,
        updated_at: nowIso,
      };
      ctx.store.insert("calendars", row);
      ctx.store.addHistory({
        entity_type: "calendar", entity_id: row.id, action: "created", actor: "user",
        summary: `iCal subscription "${row.name}" added`, details: { host: url.host }, at: nowIso,
      });
      const synced = row.enabled === 0 ? { calendar: viewOf(ctx.store, row), sync: null, error: null } : await syncOne(ctx, row);
      return {
        status: 201,
        body: { calendar: synced.calendar, sync: synced.sync, sync_error: synced.error },
      };
    },
  },
  {
    method: "PATCH",
    path: "/api/calendars/:id",
    handler: async (ctx) => {
      const existing = mustGetCalendar(ctx.store, ctx.params["id"]);
      const body = await readBody(ctx.req, updateCalendarRequestSchema);
      const nowIso = ctx.now().toISOString();
      const patch: Record<string, unknown> = { updated_at: nowIso };
      if (body.name !== undefined) patch["name"] = body.name;
      if (body.color !== undefined) patch["color"] = body.color;
      if (body.enabled !== undefined) patch["enabled"] = body.enabled ? 1 : 0;
      let urlChanged = false;
      if (body.url !== undefined) {
        const url = parseCalendarUrl(body.url);
        urlChanged = url.toString() !== existing.url;
        if (urlChanged) {
          patch["url"] = url.toString();
          patch["last_error"] = null;
        }
      }
      ctx.store.update("calendars", existing.id, patch);
      ctx.store.addHistory({
        entity_type: "calendar", entity_id: existing.id, action: "updated", actor: "user",
        summary: urlChanged ? "calendar subscription address changed" : "calendar subscription updated",
        details: { fields: Object.keys(body) }, at: nowIso,
      });
      const updated = mustGetCalendar(ctx.store, existing.id);
      const shouldSync = updated.enabled !== 0 && (urlChanged || (body.enabled === true && existing.enabled === 0) || existing.last_synced_at === null);
      if (!shouldSync) return { body: { calendar: viewOf(ctx.store, updated), sync: null, sync_error: null } };
      const synced = await syncOne(ctx, updated);
      return { body: { calendar: synced.calendar, sync: synced.sync, sync_error: synced.error } };
    },
  },
  {
    method: "DELETE",
    path: "/api/calendars/:id",
    handler: async (ctx) => {
      const calendar = mustGetCalendar(ctx.store, ctx.params["id"]);
      deleteCalendar(ctx.store, calendar, ctx.now());
      return { body: { deleted: true, id: calendar.id } };
    },
  },
  {
    method: "POST",
    path: "/api/calendars/:id/sync",
    handler: async (ctx) => {
      const calendar = mustGetCalendar(ctx.store, ctx.params["id"]);
      const synced = await syncOne(ctx, calendar);
      return { body: { calendar: synced.calendar, sync: synced.sync, sync_error: synced.error } };
    },
  },
  {
    method: "POST",
    path: "/api/calendars/sync-all",
    handler: async (ctx) => {
      const rows = ctx.store.list<CalendarRow>("calendars", [eq("enabled", 1)], { order: "created_at, id" });
      const calendars: CalendarSubscription[] = [];
      const results: CalendarSyncResult[] = [];
      const failures: Array<{ calendar_id: string; name: string; error: string }> = [];
      for (const row of rows) {
        const synced = await syncOne(ctx, row);
        calendars.push(synced.calendar);
        if (synced.sync) results.push(synced.sync);
        else failures.push({ calendar_id: row.id, name: row.name, error: synced.error ?? "unknown error" });
      }
      return { body: { calendars, results, failures } };
    },
  },
  {
    // Context recovery for one occurrence: the same grounded retrieval the
    // query box uses, asked with the event title, so an upcoming meeting
    // reopens whatever was already written about it. Read-only: nothing is
    // created and no citation is treated as a decision.
    method: "GET",
    path: "/api/calendar/events/:id/context",
    handler: async (ctx) => {
      const id = ctx.params["id"] ?? "";
      const row = ctx.store.byId<CalendarEventRow>("calendar_events", id);
      if (!row) throw notFound(`calendar event ${id} not found`);
      const event = calendarEventView(row);
      const calendar = mustGetCalendar(ctx.store, event.calendar_id);
      const question = event.summary;
      const prefs = ctx.store.list<Preference>("preferences");
      const query = groundedQuery(ctx.store, question, ctx.now(), prefs);
      return {
        body: {
          event,
          calendar: viewOf(ctx.store, calendar),
          question,
          query,
        },
      };
    },
  },
  {
    method: "GET",
    path: "/api/calendar/events",
    handler: async (ctx) => {
      const settings = ctx.store.getSettings();
      const now = ctx.now();
      const daysRaw = ctx.url.searchParams.get("days");
      const days = daysRaw === null ? 14 : Number(daysRaw);
      if (!Number.isInteger(days) || days < 1 || days > 120) {
        throw badRequest([{ path: "days", message: "days must be an integer 1..120" }]);
      }
      const fromParam = ctx.url.searchParams.get("from");
      const today = localParts(now, settings.timezone);
      const from = fromParam
        ? new Date(fromParam)
        : zonedTimeToUtc(settings.timezone, today.year, today.month, today.day, 0, 0);
      if (Number.isNaN(from.getTime())) throw badRequest([{ path: "from", message: "must be an ISO-8601 datetime" }]);
      const to = new Date(from.getTime() + days * 86_400_000);
      const events: CalendarOccurrence[] = occurrencesBetween(ctx.store, from, to);
      const calendarIds = new Set(events.map((event) => event.calendar_id));
      const calendars = ctx.store
        .list<CalendarRow>("calendars", [], { order: "created_at, id" })
        .filter((row) => calendarIds.has(row.id))
        .map((row) => viewOf(ctx.store, row));
      return { body: { from: from.toISOString(), to: to.toISOString(), timezone: settings.timezone, events, calendars } };
    },
  },
];
