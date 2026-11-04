import type { Preference, PreferenceKey, Source } from "../../shared";
import {
  createDevelopmentRequestSchema,
  createPreferenceRequestSchema,
  createSourceRequestSchema,
  updateDevelopmentRequestSchema,
  updatePreferenceRequestSchema,
  updateSourceRequestSchema,
} from "../../shared";
import {
  badRequest,
  enumParam,
  isIsoDateTime,
  isLocalDate,
  notFound,
  parsePagination,
  readBody,
  type Route,
} from "../api_util";
import type { Clause, DevelopmentRow, Store } from "../store";
import { eq, gte, likeEscape, lte } from "../store";
import { runTriage } from "../engine";
import { deleteDevelopment, deleteSource } from "../deletion";

const PREFERENCE_VALUES: Record<PreferenceKey, readonly string[]> = {
  report_style: ["concise_first", "detailed", "summary_only"],
  interruption: ["never", "digest_only", "when_strong", "immediate"],
  delivery: ["immediate", "digest"],
  proactivity: ["off", "suggestions_only", "suggestions_and_preparation"],
};

const PREFERENCE_KEYS = Object.keys(PREFERENCE_VALUES) as PreferenceKey[];

function checkPreferenceValue(key: PreferenceKey, value: string, path: string): void {
  if (!PREFERENCE_VALUES[key].includes(value)) {
    throw badRequest([
      { path, message: `value for "${key}" must be one of ${PREFERENCE_VALUES[key].join(", ")}` },
    ]);
  }
}

function mustGetSource(store: Store, id: string): Source {
  const source = store.byId<Source>("sources", id);
  if (!source) throw notFound(`source ${id} not found`);
  return source;
}

function mustGetDevelopment(store: Store, id: string): DevelopmentRow {
  const dev = store.byId<DevelopmentRow>("developments", id);
  if (!dev) throw notFound(`development ${id} not found`);
  return dev;
}

const SEARCH_SOURCE = (q: string): Clause => ({
  sql: "(title LIKE ? ESCAPE '\\' OR evidence_summary LIKE ? ESCAPE '\\')",
  params: [likeEscape(q), likeEscape(q)],
});

export const recordRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/preferences",
    handler: async (ctx) => {
      const { limit, offset } = parsePagination(ctx.url);
      const clauses: Clause[] = [];
      const scope = ctx.url.searchParams.get("scope");
      if (scope) clauses.push(eq("scope", scope));
      const status = enumParam(ctx.url, "status", ["active", "withdrawn"] as const);
      if (status) clauses.push(eq("status", status));
      return {
        body: {
          preferences: ctx.store.list<Preference>("preferences", clauses, { limit, offset }),
          total: ctx.store.count("preferences", clauses),
        },
      };
    },
  },
  {
    method: "POST",
    path: "/api/preferences",
    handler: async (ctx) => {
      const body = await readBody(ctx.req, createPreferenceRequestSchema);
      checkPreferenceValue(body.key, body.value, "value");
      const nowIso = ctx.now().toISOString();
      const preference: Preference = {
        id: crypto.randomUUID(),
        key: body.key,
        scope: body.scope ?? "global",
        value: body.value,
        status: "active",
        provenance: "user_stated",
        created_at: nowIso,
        updated_at: nowIso,
        version: 1,
      };
      ctx.store.insert("preferences", preference);
      ctx.store.addHistory({
        entity_type: "preference", entity_id: preference.id, action: "created", actor: "user",
        summary: `preference ${preference.key}=${preference.value} set for scope ${preference.scope}`,
        details: { key: preference.key, scope: preference.scope, value: preference.value }, at: nowIso,
      });
      return { status: 201, body: { preference } };
    },
  },
  {
    method: "PATCH",
    path: "/api/preferences/:id",
    handler: async (ctx) => {
      const existing = ctx.store.byId<Preference>("preferences", ctx.params["id"]!);
      if (!existing) throw notFound(`preference ${ctx.params["id"]} not found`);
      const body = await readBody(ctx.req, updatePreferenceRequestSchema);
      const key = body.key ?? existing.key;
      if (!PREFERENCE_KEYS.includes(key)) {
        throw badRequest([{ path: "key", message: "unknown preference key" }]);
      }
      const value = body.value ?? existing.value;
      checkPreferenceValue(key, value, "value");
      const nowIso = ctx.now().toISOString();
      const updated: Preference = {
        ...existing,
        key,
        scope: body.scope ?? existing.scope,
        value,
        status: body.status ?? existing.status,
        updated_at: nowIso,
        version:
          body.key !== undefined || body.scope !== undefined || body.value !== undefined
            ? existing.version + 1
            : existing.version,
      };
      ctx.store.update("preferences", existing.id, { ...updated });
      ctx.store.addHistory({
        entity_type: "preference", entity_id: existing.id,
        action: body.status === "withdrawn" ? "withdrawn" : "updated", actor: "user",
        summary: body.status === "withdrawn"
          ? `preference ${updated.key} withdrawn for scope ${updated.scope}`
          : `preference ${updated.key}=${updated.value} for scope ${updated.scope} (version ${updated.version})`,
        details: { key: updated.key, scope: updated.scope, value: updated.value, status: updated.status }, at: nowIso,
      });
      return { body: { preference: updated } };
    },
  },
  {
    method: "GET",
    path: "/api/sources",
    handler: async (ctx) => {
      const { limit, offset } = parsePagination(ctx.url);
      const q = ctx.url.searchParams.get("q");
      const clauses = q ? [SEARCH_SOURCE(q)] : [];
      return {
        body: {
          sources: ctx.store.list<Source>("sources", clauses, { limit, offset }),
          total: ctx.store.count("sources", clauses),
        },
      };
    },
  },
  {
    method: "POST",
    path: "/api/sources",
    handler: async (ctx) => {
      const body = await readBody(ctx.req, createSourceRequestSchema);
      if (!body.title.trim()) throw badRequest([{ path: "title", message: "title must not be empty" }]);
      if (!body.evidence_summary.trim()) {
        throw badRequest([{ path: "evidence_summary", message: "evidence_summary must not be empty" }]);
      }
      if (body.published_at !== null && body.published_at !== undefined && !isLocalDate(body.published_at)) {
        throw badRequest([{ path: "published_at", message: "must be a YYYY-MM-DD date or null" }]);
      }
      const nowIso = ctx.now().toISOString();
      const source: Source = {
        id: crypto.randomUUID(),
        title: body.title,
        url: body.url ?? null,
        publisher: body.publisher ?? null,
        published_at: body.published_at ?? null,
        evidence_summary: body.evidence_summary,
        created_at: nowIso,
      };
      ctx.store.insert("sources", source);
      ctx.store.addHistory({
        entity_type: "source", entity_id: source.id, action: "created", actor: "user",
        summary: "source added", details: { title: source.title }, at: nowIso,
      });
      return { status: 201, body: { source } };
    },
  },
  {
    method: "PATCH",
    path: "/api/sources/:id",
    handler: async (ctx) => {
      const existing = mustGetSource(ctx.store, ctx.params["id"]!);
      const body = await readBody(ctx.req, updateSourceRequestSchema);
      if (body.published_at !== null && body.published_at !== undefined && !isLocalDate(body.published_at)) {
        throw badRequest([{ path: "published_at", message: "must be a YYYY-MM-DD date or null" }]);
      }
      const nowIso = ctx.now().toISOString();
      const updated: Source = {
        ...existing,
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.url !== undefined ? { url: body.url } : {}),
        ...(body.publisher !== undefined ? { publisher: body.publisher } : {}),
        ...(body.published_at !== undefined ? { published_at: body.published_at } : {}),
        ...(body.evidence_summary !== undefined ? { evidence_summary: body.evidence_summary } : {}),
        created_at: existing.created_at,
      };
      ctx.store.update("sources", existing.id, { ...updated });
      ctx.store.addHistory({
        entity_type: "source", entity_id: existing.id, action: "updated", actor: "user",
        summary: "source updated", details: { fields: Object.keys(body) }, at: nowIso,
      });
      return { body: { source: updated } };
    },
  },
  {
    method: "DELETE",
    path: "/api/sources/:id",
    handler: async (ctx) => {
      const source = mustGetSource(ctx.store, ctx.params["id"]!);
      deleteSource(ctx.store, source, ctx.now());
      return { body: { deleted: true, id: source.id } };
    },
  },
  {
    method: "GET",
    path: "/api/developments",
    handler: async (ctx) => {
      const { limit, offset } = parsePagination(ctx.url);
      const clauses: Clause[] = [];
      const from = ctx.url.searchParams.get("from");
      if (from) {
        if (!isIsoDateTime(from)) throw badRequest([{ path: "from", message: "must be an ISO-8601 datetime" }]);
        clauses.push(gte("occurred_at", from));
      }
      const to = ctx.url.searchParams.get("to");
      if (to) {
        if (!isIsoDateTime(to)) throw badRequest([{ path: "to", message: "must be an ISO-8601 datetime" }]);
        clauses.push(lte("occurred_at", to));
      }
      const sourceId = ctx.url.searchParams.get("source_id");
      if (sourceId) clauses.push(eq("source_id", sourceId));
      return {
        body: {
          developments: ctx.store.list<DevelopmentRow>("developments", clauses, { limit, offset }),
          total: ctx.store.count("developments", clauses),
        },
      };
    },
  },
  {
    method: "POST",
    path: "/api/developments",
    handler: async (ctx) => {
      const body = await readBody(ctx.req, createDevelopmentRequestSchema);
      if (!isIsoDateTime(body.occurred_at)) {
        throw badRequest([{ path: "occurred_at", message: "must be an ISO-8601 datetime" }]);
      }
      if (body.deadline !== null && body.deadline !== undefined && !isIsoDateTime(body.deadline)) {
        throw badRequest([{ path: "deadline", message: "must be an ISO-8601 datetime or null" }]);
      }
      if (!body.summary.trim()) throw badRequest([{ path: "summary", message: "summary must not be empty" }]);
      if (!ctx.store.byId("sources", body.source_id)) {
        throw badRequest([{ path: "source_id", message: `source ${body.source_id} not found` }]);
      }
      const addresses = body.addresses_obstacle_entry_ids ?? [];
      for (const id of addresses) {
        if (!ctx.store.byId("entries", id)) {
          throw badRequest([{ path: "addresses_obstacle_entry_ids", message: `entry ${id} not found` }]);
        }
      }
      const now = ctx.now();
      const dev: DevelopmentRow = {
        id: crypto.randomUUID(),
        source_id: body.source_id,
        occurred_at: body.occurred_at,
        summary: body.summary,
        content: body.content ?? null,
        time_sensitivity: body.time_sensitivity ?? "none",
        deadline: body.deadline ?? null,
        addresses_obstacle_entry_ids: addresses,
        created_at: now.toISOString(),
      };
      ctx.store.insert("developments", dev);
      ctx.store.addHistory({
        entity_type: "development", entity_id: dev.id, action: "created", actor: "user",
        summary: "development recorded", details: { source_id: dev.source_id }, at: dev.created_at,
      });
      const triage = runTriage(ctx.store, dev, now);
      return {
        status: 201,
        body: {
          development: dev,
          suggestions: triage.suggestions,
          triage_events: triage.triage_events,
        },
      };
    },
  },
  {
    method: "PATCH",
    path: "/api/developments/:id",
    handler: async (ctx) => {
      const existing = mustGetDevelopment(ctx.store, ctx.params["id"]!);
      const body = await readBody(ctx.req, updateDevelopmentRequestSchema);
      if (body.occurred_at !== undefined && !isIsoDateTime(body.occurred_at)) {
        throw badRequest([{ path: "occurred_at", message: "must be an ISO-8601 datetime" }]);
      }
      if (body.deadline !== null && body.deadline !== undefined && !isIsoDateTime(body.deadline)) {
        throw badRequest([{ path: "deadline", message: "must be an ISO-8601 datetime or null" }]);
      }
      if (body.addresses_obstacle_entry_ids !== undefined) {
        for (const id of body.addresses_obstacle_entry_ids) {
          if (!ctx.store.byId("entries", id)) {
            throw badRequest([{ path: "addresses_obstacle_entry_ids", message: `entry ${id} not found` }]);
          }
        }
      }
      const nowIso = ctx.now().toISOString();
      const updated: DevelopmentRow = {
        ...existing,
        ...(body.occurred_at !== undefined ? { occurred_at: body.occurred_at } : {}),
        ...(body.summary !== undefined ? { summary: body.summary } : {}),
        ...(body.content !== undefined ? { content: body.content } : {}),
        ...(body.time_sensitivity !== undefined ? { time_sensitivity: body.time_sensitivity } : {}),
        ...(body.deadline !== undefined ? { deadline: body.deadline } : {}),
        ...(body.addresses_obstacle_entry_ids !== undefined
          ? { addresses_obstacle_entry_ids: body.addresses_obstacle_entry_ids }
          : {}),
        created_at: existing.created_at,
      };
      ctx.store.update("developments", existing.id, { ...updated });
      ctx.store.addHistory({
        entity_type: "development", entity_id: existing.id, action: "updated", actor: "user",
        summary: "development updated (triage not re-run)", details: { fields: Object.keys(body) }, at: nowIso,
      });
      return { body: { development: updated } };
    },
  },
  {
    method: "DELETE",
    path: "/api/developments/:id",
    handler: async (ctx) => {
      const dev = mustGetDevelopment(ctx.store, ctx.params["id"]!);
      deleteDevelopment(ctx.store, dev, ctx.now());
      return { body: { deleted: true, id: dev.id } };
    },
  },
];
