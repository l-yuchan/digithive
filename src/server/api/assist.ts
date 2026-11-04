import type { Entry, HistoryEvent, Preparation, Suggestion, TriageEvent } from "../../shared";
import { createPreparationRequestSchema, suggestionResponseRequestSchema } from "../../shared";
import {
  badRequest,
  enumParam,
  invalidTransition,
  isIsoDateTime,
  notFound,
  parsePagination,
  readBody,
  requireIso,
  type Route,
} from "../api_util";
import type { DevelopmentRow, Store, SuggestionRow } from "../store";
import { eq, suggestionView } from "../store";
import { releasePass } from "../engine";
import { groundedQuery } from "../retrieval";
import { runPreparation, stopPreparation } from "../preparation";
import { applyCorrection, promoteEntry, validateContextPatch } from "../entry_ops";

const RESPONDABLE = ["queued", "held", "surfaced", "deferred"] as const;

function mustGetSuggestion(store: Store, id: string): SuggestionRow {
  const s = store.byId<SuggestionRow>("suggestions", id);
  if (!s) throw notFound(`suggestion ${id} not found`);
  return s;
}

function recordResponse(
  store: Store,
  s: SuggestionRow,
  action: Suggestion["response"] extends null ? never : NonNullable<Suggestion["response"]>["action"],
  note: string | null,
  now: Date,
): void {
  store.update("suggestions", s.id, {
    response: { action, note, at: now.toISOString() },
    updated_at: now.toISOString(),
  });
}

export const assistRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/suggestions",
    handler: async (ctx) => {
      releasePass(ctx.store, ctx.now());
      const { limit, offset } = parsePagination(ctx.url);
      const clauses = [];
      const status = enumParam(ctx.url, "status", [
        "queued", "held", "surfaced", "accepted", "dismissed", "deferred", "expired",
      ] as const);
      if (status) clauses.push(eq("status", status));
      const strength = enumParam(ctx.url, "strength", ["strong", "weak"] as const);
      if (strength) clauses.push(eq("strength", strength));
      const entryId = ctx.url.searchParams.get("entry_id");
      if (entryId) clauses.push(eq("entry_id", entryId));
      return {
        body: {
          suggestions: ctx.store.list<SuggestionRow>("suggestions", clauses, { limit, offset }).map(suggestionView),
          total: ctx.store.count("suggestions", clauses),
        },
      };
    },
  },
  {
    method: "GET",
    path: "/api/suggestions/:id",
    handler: async (ctx) => {
      releasePass(ctx.store, ctx.now());
      const s = mustGetSuggestion(ctx.store, ctx.params["id"]!);
      const entry = ctx.store.byId<Entry>("entries", s.entry_id);
      const development = ctx.store.byId<DevelopmentRow>("developments", s.development_id);
      const source = development ? ctx.store.byId("sources", development.source_id) : null;
      if (!entry || !development) throw notFound("suggestion anchors not found");
      return { body: { suggestion: suggestionView(s), entry, development, source } };
    },
  },
  {
    method: "POST",
    path: "/api/suggestions/:id/respond",
    handler: async (ctx) => {
      const s = mustGetSuggestion(ctx.store, ctx.params["id"]!);
      if (!RESPONDABLE.includes(s.status as (typeof RESPONDABLE)[number])) {
        throw invalidTransition(`cannot respond to a suggestion in status ${s.status}`);
      }
      const body = await readBody(ctx.req, suggestionResponseRequestSchema);
      const store = ctx.store;
      const now = ctx.now();
      const entry = store.byId<Entry>("entries", s.entry_id);
      if (!entry) throw notFound("entry not found");
      const events: HistoryEvent[] = [];
      const created: { entry?: Entry; preparation?: Preparation } = {};
      const pushHistory = (action: string, summary: string, details: Record<string, unknown> | null) => {
        events.push(store.addHistory({
          entity_type: "suggestion", entity_id: s.id, action, actor: "user",
          summary, details, at: now.toISOString(),
        }));
      };
      if (body.action === "accept") {
        if (body.promote_to) {
          if (body.promote_to.kind === "delegation" && !(body.promote_to.scope ?? "").trim()) {
            throw badRequest([{ path: "promote_to.scope", message: "scope is required for delegation" }]);
          }
          if (body.promote_to.due_at !== undefined && body.promote_to.due_at !== null) {
            requireIso(body.promote_to.due_at, "promote_to.due_at");
          }
        }
        recordResponse(store, s, "accept", body.note ?? null, now);
        if (body.promote_to) {
          created.entry = promoteEntry(store, entry, {
            to: body.promote_to.kind,
            ...(body.promote_to.text !== undefined ? { text: body.promote_to.text } : {}),
            ...(body.promote_to.due_at !== undefined ? { due_at: body.promote_to.due_at } : {}),
            ...(body.promote_to.scope !== undefined ? { scope: body.promote_to.scope } : {}),
            ...(body.promote_to.max_steps !== undefined ? { max_steps: body.promote_to.max_steps } : {}),
          }, now);
        }
        store.update("suggestions", s.id, { status: "accepted", updated_at: now.toISOString() });
        pushHistory("accepted", `accepted${body.promote_to ? " with promotion" : ""}`, {
          promoted_to: body.promote_to?.kind ?? null, note: body.note ?? null,
        });
      } else if (body.action === "dismiss") {
        recordResponse(store, s, "dismiss", body.reason ?? null, now);
        store.update("suggestions", s.id, { status: "dismissed", updated_at: now.toISOString() });
        pushHistory("dismissed", "dismissed; this pair never resurfaces", { reason: body.reason ?? null });
      } else if (body.action === "defer") {
        requireIso(body.defer_until, "defer_until");
        recordResponse(store, s, "defer", null, now);
        store.update("suggestions", s.id, {
          status: "deferred",
          hold_until: body.defer_until,
          updated_at: now.toISOString(),
        });
        pushHistory("deferred", "deferred; resurfaces once at defer_until", { defer_until: body.defer_until });
      } else if (body.action === "correct") {
        const patch = (body.correction.context ?? {}) as Record<string, unknown>;
        if (body.correction.text !== undefined && !body.correction.text.trim()) {
          throw badRequest([{ path: "correction.text", message: "text must not be empty" }]);
        }
        const cleaned = validateContextPatch(entry, patch);
        applyCorrection(store, entry, {
          ...(body.correction.text !== undefined ? { text: body.correction.text } : {}),
          ...(cleaned !== undefined ? { context: cleaned } : {}),
          ...(body.correction.correction_note !== undefined
            ? { correction_note: body.correction.correction_note }
            : {}),
        }, now);
        recordResponse(store, s, "correct", null, now);
        pushHistory("corrected", "entry corrected from suggestion response", null);
      } else {
        const prep: Preparation = {
          id: crypto.randomUUID(),
          request: body.request,
          delegation_id: null,
          suggestion_id: s.id,
          scope: entry.scope,
          max_steps: body.max_steps ?? 3,
          status: "pending",
          produced_actions: [],
          result_summary: null,
          model: "rules",
          created_at: now.toISOString(),
          updated_at: now.toISOString(),
        };
        store.insert("preparations", prep);
        store.addHistory({
          entity_type: "preparation", entity_id: prep.id, action: "created", actor: "user",
          summary: "bounded local preparation requested (pending; run explicitly)",
          details: { suggestion_id: s.id, scope: prep.scope, max_steps: prep.max_steps }, at: prep.created_at,
        });
        recordResponse(store, s, "explore", null, now);
        created.preparation = prep;
        pushHistory("explored", "explore requested; local preparation created", { preparation_id: prep.id });
      }
      const freshEntry = store.byId<Entry>("entries", s.entry_id) ?? entry;
      const freshSuggestion = mustGetSuggestion(store, s.id);
      return {
        body: {
          suggestion: suggestionView(freshSuggestion),
          entry: freshEntry,
          created,
          history: events,
        },
      };
    },
  },
  {
    method: "GET",
    path: "/api/triage-events",
    handler: async (ctx) => {
      const { limit, offset } = parsePagination(ctx.url);
      const clauses = [];
      const devId = ctx.url.searchParams.get("development_id");
      if (devId) clauses.push(eq("development_id", devId));
      const entryId = ctx.url.searchParams.get("entry_id");
      if (entryId) clauses.push(eq("entry_id", entryId));
      return {
        body: {
          triage_events: ctx.store.list<TriageEvent>("triage_events", clauses, {
            limit, offset, order: "at, id",
          }),
          total: ctx.store.count("triage_events", clauses),
        },
      };
    },
  },
  {
    method: "POST",
    path: "/api/retrieval/query",
    handler: async (ctx) => {
      const body = (await ctx.req.json().catch(() => null)) as { question?: unknown; at?: unknown } | null;
      if (!body || typeof body !== "object") {
        throw badRequest([{ path: "body", message: "a JSON object body is required" }]);
      }
      if (typeof body.question !== "string" || !body.question.trim()) {
        throw badRequest([{ path: "question", message: "question must be a non-empty string" }]);
      }
      let at = ctx.now();
      if (body.at !== undefined && body.at !== null) {
        if (!isIsoDateTime(body.at)) throw badRequest([{ path: "at", message: "must be an ISO-8601 datetime" }]);
        at = new Date(body.at);
      }
      const prefs = ctx.store.list<import("../../shared").Preference>("preferences");
      return { body: groundedQuery(ctx.store, body.question, at, prefs) };
    },
  },
  {
    method: "GET",
    path: "/api/preparations",
    handler: async (ctx) => {
      const { limit, offset } = parsePagination(ctx.url);
      const clauses = [];
      const status = enumParam(ctx.url, "status", [
        "pending", "in_progress", "done", "stopped", "failed",
      ] as const);
      if (status) clauses.push(eq("status", status));
      return {
        body: {
          preparations: ctx.store.list<Preparation>("preparations", clauses, { limit, offset }),
          total: ctx.store.count("preparations", clauses),
        },
      };
    },
  },
  {
    method: "GET",
    path: "/api/preparations/:id",
    handler: async (ctx) => {
      const prep = ctx.store.byId<Preparation>("preparations", ctx.params["id"]!);
      if (!prep) throw notFound(`preparation ${ctx.params["id"]} not found`);
      return { body: { preparation: prep } };
    },
  },
  {
    method: "POST",
    path: "/api/preparations",
    handler: async (ctx) => {
      const body = await readBody(ctx.req, createPreparationRequestSchema);
      if (!body.request.trim()) throw badRequest([{ path: "request", message: "request must not be empty" }]);
      if (!body.scope.trim()) throw badRequest([{ path: "scope", message: "scope must not be empty" }]);
      if (body.delegation_id && !ctx.store.byId("entries", body.delegation_id)) {
        throw badRequest([{ path: "delegation_id", message: `entry ${body.delegation_id} not found` }]);
      }
      if (body.suggestion_id && !ctx.store.byId("suggestions", body.suggestion_id)) {
        throw badRequest([{ path: "suggestion_id", message: `suggestion ${body.suggestion_id} not found` }]);
      }
      const nowIso = ctx.now().toISOString();
      const prep: Preparation = {
        id: crypto.randomUUID(),
        request: body.request,
        delegation_id: body.delegation_id ?? null,
        suggestion_id: body.suggestion_id ?? null,
        scope: body.scope,
        max_steps: body.max_steps ?? 3,
        status: "pending",
        produced_actions: [],
        result_summary: null,
        model: "rules",
        created_at: nowIso,
        updated_at: nowIso,
      };
      ctx.store.insert("preparations", prep);
      ctx.store.addHistory({
        entity_type: "preparation", entity_id: prep.id, action: "created", actor: "user",
        summary: "bounded local preparation requested (pending; run explicitly)",
        details: { scope: prep.scope, max_steps: prep.max_steps }, at: nowIso,
      });
      return { status: 201, body: { preparation: prep } };
    },
  },
  {
    // Added endpoint (lead override): preparations are created pending and run
    // via this explicit action, so a stop before executing is possible.
    method: "POST",
    path: "/api/preparations/:id/run",
    handler: async (ctx) => {
      const prep = ctx.store.byId<Preparation>("preparations", ctx.params["id"]!);
      if (!prep) throw notFound(`preparation ${ctx.params["id"]} not found`);
      if (prep.status !== "pending") {
        throw invalidTransition(`cannot run a preparation in status ${prep.status}`);
      }
      const updated = runPreparation(ctx.store, prep, ctx.now());
      ctx.store.addHistory({
        entity_type: "preparation", entity_id: prep.id,
        action: updated.status === "done" ? "completed" : updated.status, actor: "system_rules",
        summary: `preparation ${updated.status} (${updated.produced_actions.length} steps)`,
        details: { steps: updated.produced_actions.length, status: updated.status }, at: ctx.now().toISOString(),
      });
      return { body: { preparation: updated } };
    },
  },
  {
    method: "POST",
    path: "/api/preparations/:id/stop",
    handler: async (ctx) => {
      const prep = ctx.store.byId<Preparation>("preparations", ctx.params["id"]!);
      if (!prep) throw notFound(`preparation ${ctx.params["id"]} not found`);
      if (prep.status !== "pending" && prep.status !== "in_progress") {
        throw invalidTransition(`cannot stop a preparation in status ${prep.status}`);
      }
      const updated = stopPreparation(ctx.store, prep, ctx.now());
      ctx.store.addHistory({
        entity_type: "preparation", entity_id: prep.id, action: "stopped", actor: "user",
        summary: "preparation stopped; audit preserved",
        details: { steps: updated.produced_actions.length }, at: ctx.now().toISOString(),
      });
      return { body: { preparation: updated } };
    },
  },
];
