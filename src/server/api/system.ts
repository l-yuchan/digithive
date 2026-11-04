import type { CapabilitiesResponse, DigestResponse, HistoryEvent, Settings, Suggestion, TriageEvent } from "../../shared";
import { deleteAllRequestSchema } from "../../shared";
import {
  badRequest,
  enumParam,
  isIsoDateTime,
  isLocalDate,
  parsePagination,
  readBody,
  requireIso,
  requireTimeOfDay,
  type Route,
} from "../api_util";
import type { SuggestionRow, Store } from "../store";
import { defaultSettings, eq, suggestionView } from "../store";
import { isValidTimeZone, localDateOf } from "../time";
import { releasePass } from "../engine";
import { buildExportBundle, createSnapshot } from "../backup";
import { wipeAllData } from "../deletion";
import { LIMITATIONS_NOTICE, llmStatus } from "../llm";

const HISTORY_ENTITY_TYPES = [
  "entry", "preference", "source", "development", "suggestion",
  "preparation", "settings", "evaluation", "system",
] as const;

function parseSettingsPatch(raw: unknown, existing: Settings): Settings {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw badRequest([{ path: "body", message: "a JSON object body is required" }]);
  }
  const body = raw as Record<string, unknown>;
  const next: Settings = { ...existing };
  if ("quiet_mode" in body) {
    if (typeof body.quiet_mode !== "boolean") throw badRequest([{ path: "quiet_mode", message: "must be a boolean" }]);
    next.quiet_mode = body.quiet_mode;
  }
  if ("quiet_until" in body) {
    const v = body.quiet_until;
    if (v === null) next.quiet_until = null;
    else if (isIsoDateTime(v)) next.quiet_until = v;
    else throw badRequest([{ path: "quiet_until", message: "must be an ISO-8601 datetime or null" }]);
  }
  if ("delivery" in body) {
    if (body.delivery !== "immediate" && body.delivery !== "digest") {
      throw badRequest([{ path: "delivery", message: "must be immediate or digest" }]);
    }
    next.delivery = body.delivery;
  }
  if ("digest_time" in body) next.digest_time = requireTimeOfDay(body.digest_time, "digest_time");
  if ("timezone" in body) {
    if (typeof body.timezone !== "string" || !isValidTimeZone(body.timezone)) {
      throw badRequest([{ path: "timezone", message: "must be a valid IANA timezone" }]);
    }
    next.timezone = body.timezone;
  }
  if ("focus_windows" in body) {
    const rawWindows = body.focus_windows;
    if (!Array.isArray(rawWindows)) throw badRequest([{ path: "focus_windows", message: "must be an array" }]);
    next.focus_windows = rawWindows.map((w, i) => {
      if (w === null || typeof w !== "object") {
        throw badRequest([{ path: `focus_windows.${i}`, message: "must be an object" }]);
      }
      const win = w as Record<string, unknown>;
      if (typeof win.label !== "string" || !win.label.trim()) {
        throw badRequest([{ path: `focus_windows.${i}.label`, message: "label must be a non-empty string" }]);
      }
      if (!Array.isArray(win.days) || win.days.length === 0) {
        throw badRequest([{ path: `focus_windows.${i}.days`, message: "must be a non-empty array of weekdays 0..6" }]);
      }
      const days = win.days.map((d) => {
        if (typeof d !== "number" || !Number.isInteger(d) || d < 0 || d > 6) {
          throw badRequest([{ path: `focus_windows.${i}.days`, message: "weekdays are integers 0..6 (0 = Sunday)" }]);
        }
        return d;
      });
      return {
        id: typeof win.id === "string" && win.id ? win.id : crypto.randomUUID(),
        label: win.label,
        days: [...new Set(days)],
        start: requireTimeOfDay(win.start, `focus_windows.${i}.start`),
        end: requireTimeOfDay(win.end, `focus_windows.${i}.end`),
      };
    });
  }
  return next;
}

export const systemRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/system/capabilities",
    handler: async () => {
      const cap: CapabilitiesResponse = {
        app: "digithive",
        schema_version: 1,
        ...llmStatus(),
        limitations_notice: LIMITATIONS_NOTICE,
      };
      return { body: cap };
    },
  },
  {
    method: "GET",
    path: "/api/settings",
    handler: async (ctx) => ({ body: { settings: ctx.store.getSettings() } }),
  },
  {
    method: "PATCH",
    path: "/api/settings",
    handler: async (ctx) => {
      const raw = await ctx.req.json().catch(() => null);
      const existing = ctx.store.getSettings();
      const next = parseSettingsPatch(raw, existing);
      ctx.store.saveSettings(next);
      const changed = Object.keys(next).filter(
        (k) => JSON.stringify(next[k as keyof Settings]) !== JSON.stringify(existing[k as keyof Settings]),
      );
      ctx.store.addHistory({
        entity_type: "settings", entity_id: "settings", action: "updated", actor: "user",
        summary: changed.length > 0 ? `settings updated (${changed.join(", ")})` : "settings patched (no change)",
        details: { changed }, at: ctx.now().toISOString(),
      });
      return { body: { settings: next } };
    },
  },
  {
    method: "GET",
    path: "/api/digest",
    handler: async (ctx) => {
      const now = ctx.now();
      releasePass(ctx.store, now);
      const settings = ctx.store.getSettings();
      const dateParam = ctx.url.searchParams.get("date");
      if (dateParam !== null && !isLocalDate(dateParam)) {
        throw badRequest([{ path: "date", message: "must be a YYYY-MM-DD date" }]);
      }
      const date = dateParam ?? localDateOf(now, settings.timezone);
      const held = ctx.store.list<SuggestionRow>("suggestions", [eq("status", "held")]).map(suggestionView);
      const surfaced = ctx.store
        .list<SuggestionRow>("suggestions", [eq("status", "surfaced")])
        .filter((s) => s.surfaced_at && localDateOf(new Date(s.surfaced_at), settings.timezone) === date)
        .map(suggestionView);
      const suppressed = ctx.store
        .list<TriageEvent>("triage_events", [eq("outcome", "suppressed")], { order: "at, id" })
        .filter((t) => localDateOf(new Date(t.at), settings.timezone) === date);
      const digest: DigestResponse = {
        date,
        generated_at: now.toISOString(),
        held,
        surfaced_today: surfaced,
        counts: { held: held.length, surfaced: surfaced.length, suppressed: suppressed.length },
      };
      return { body: digest };
    },
  },
  {
    method: "GET",
    path: "/api/history",
    handler: async (ctx) => {
      const { limit, offset } = parsePagination(ctx.url);
      const clauses = [];
      const entityType = enumParam(ctx.url, "entity_type", HISTORY_ENTITY_TYPES);
      if (entityType) clauses.push(eq("entity_type", entityType));
      const entityId = ctx.url.searchParams.get("entity_id");
      if (entityId) clauses.push(eq("entity_id", entityId));
      const from = ctx.url.searchParams.get("from");
      if (from) clauses.push({ sql: "at >= ?", params: [requireIso(from, "from")] });
      const to = ctx.url.searchParams.get("to");
      if (to) clauses.push({ sql: "at <= ?", params: [requireIso(to, "to")] });
      return {
        body: {
          events: ctx.store.list<HistoryEvent>("history_events", clauses, { limit, offset, order: "at, id" }),
          total: ctx.store.count("history_events", clauses),
        },
      };
    },
  },
  {
    method: "GET",
    path: "/api/backup/export",
    handler: async (ctx) => {
      const bundle = buildExportBundle(ctx.store, ctx.now());
      const name = `digithive-export-${ctx.now().toISOString().replace(/[:.]/g, "-")}.json`;
      return new Response(JSON.stringify(bundle, null, 2), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="${name}"`,
        },
      });
    },
  },
  {
    method: "POST",
    path: "/api/backup/snapshot",
    handler: async (ctx) => {
      const snapshot = createSnapshot(ctx.store, ctx.backupDir, ctx.now());
      ctx.store.addHistory({
        entity_type: "system", entity_id: snapshot.id, action: "created", actor: "user",
        summary: `SQLite snapshot ${snapshot.file_name} (${snapshot.size_bytes} bytes)`,
        details: { file_name: snapshot.file_name, size_bytes: snapshot.size_bytes }, at: ctx.now().toISOString(),
      });
      return { status: 201, body: { snapshot } };
    },
  },
  {
    method: "DELETE",
    path: "/api/data/all",
    handler: async (ctx) => {
      await readBody(ctx.req, deleteAllRequestSchema);
      wipeAllData(ctx.store, defaultSettings);
      return { body: { deleted: true } };
    },
  },
];
