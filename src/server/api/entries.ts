import type { Entry, HistoryEvent, Preparation } from "../../shared";
import {
  cancelScheduleRequestSchema,
  createEntryRequestSchema,
  promoteRequestSchema,
  updateEntryRequestSchema,
  withdrawRequestSchema,
} from "../../shared";
import {
  badRequest,
  enumParam,
  notFound,
  parsePagination,
  readBody,
  requireIso,
  type Route,
} from "../api_util";
import type { Clause, Store, SuggestionRow } from "../store";
import { eq, likeClause, likeEscape, suggestionView } from "../store";
import {
  applyCorrection,
  checkContextKeys,
  createEntry,
  fillContextDefaults,
  promoteEntry,
  requireTransition,
  validateContextPatch,
} from "../entry_ops";
import { expireSuggestionsForEntry, releasePass } from "../engine";
import { deleteEntry } from "../deletion";
import { stopPreparation } from "../preparation";

const KINDS = ["interest", "fact", "hypothesis", "commitment", "delegation"] as const;
const STATUSES = ["active", "paused", "withdrawn", "completed", "cancelled"] as const;

function mustGetEntry(store: Store, id: string): Entry {
  const entry = store.byId<Entry>("entries", id);
  if (!entry) throw notFound(`entry ${id} not found`);
  return entry;
}

function linkedLivePreparations(store: Store, entryId: string): Preparation[] {
  const suggestionIds = store.list<SuggestionRow>("suggestions", [eq("entry_id", entryId)]).map((s) => s.id);
  const clause: Clause = suggestionIds.length
    ? {
        sql: `delegation_id = ? OR suggestion_id IN (${suggestionIds.map(() => "?").join(", ")})`,
        params: [entryId, ...suggestionIds],
      }
    : { sql: "delegation_id = ?", params: [entryId] };
  return store
    .list<Preparation>("preparations", [clause])
    .filter((p) => p.status === "pending" || p.status === "in_progress");
}

export const entryRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/entries",
    handler: async (ctx) => {
      const { limit, offset } = parsePagination(ctx.url);
      const clauses: Clause[] = [];
      const kind = enumParam(ctx.url, "kind", KINDS);
      if (kind) clauses.push(eq("kind", kind));
      const status = enumParam(ctx.url, "status", STATUSES);
      if (status) clauses.push(eq("status", status));
      const q = ctx.url.searchParams.get("q");
      if (q) clauses.push(likeClause("text", likeEscape(q)));
      return {
        body: {
          entries: ctx.store.list<Entry>("entries", clauses, { limit, offset }),
          total: ctx.store.count("entries", clauses),
        },
      };
    },
  },
  {
    method: "POST",
    path: "/api/entries",
    handler: async (ctx) => {
      const raw = await ctx.req.json().catch(() => null) as Record<string, unknown> | null;
      if (!raw || typeof raw !== "object") throw badRequest([{ path: "body", message: "a JSON object body is required" }]);
      const body = createEntryRequestSchema.parse(fillContextDefaults(raw));
      if (!body.text.trim()) throw badRequest([{ path: "text", message: "text must not be empty" }]);
      if (body.context.kind === "delegation" && !body.context.scope.trim()) {
        throw badRequest([{ path: "context.scope", message: "delegation scope must not be empty" }]);
      }
      for (const id of body.source_ids ?? []) {
        if (!ctx.store.byId("sources", id)) {
          throw badRequest([{ path: "source_ids", message: `source ${id} not found` }]);
        }
      }
      const entry = createEntry(
        ctx.store,
        {
          kind: body.kind,
          text: body.text,
          context: body.context,
          ...(body.source_ids !== undefined ? { source_ids: body.source_ids } : {}),
          ...(body.scope !== undefined ? { scope: body.scope } : {}),
        },
        ctx.now(),
      );
      return { status: 201, body: { entry } };
    },
  },
  {
    method: "GET",
    path: "/api/entries/:id",
    handler: async (ctx) => {
      releasePass(ctx.store, ctx.now());
      const entry = mustGetEntry(ctx.store, ctx.params["id"]!);
      const history = ctx.store.list<HistoryEvent>("history_events", [
        eq("entity_type", "entry"),
        eq("entity_id", entry.id),
      ], { order: "at, id" });
      const suggestions = ctx.store
        .list<SuggestionRow>("suggestions", [eq("entry_id", entry.id)])
        .map(suggestionView);
      return { body: { entry, history, suggestions } };
    },
  },
  {
    method: "PATCH",
    path: "/api/entries/:id",
    handler: async (ctx) => {
      const entry = mustGetEntry(ctx.store, ctx.params["id"]!);
      const body = await readBody(ctx.req, updateEntryRequestSchema);
      if (body.text !== undefined && !body.text.trim()) {
        throw badRequest([{ path: "text", message: "text must not be empty" }]);
      }
      const contextPatch = (body.context ?? {}) as Record<string, unknown>;
      checkContextKeys(entry.kind, contextPatch);
      const cleaned = validateContextPatch(entry, contextPatch);
      const updated = applyCorrection(
        ctx.store,
        entry,
        {
          ...(body.text !== undefined ? { text: body.text } : {}),
          ...(cleaned !== undefined ? { context: cleaned } : {}),
          ...(body.correction_note !== undefined ? { correction_note: body.correction_note } : {}),
        },
        ctx.now(),
      );
      return { body: { entry: updated } };
    },
  },
  {
    method: "DELETE",
    path: "/api/entries/:id",
    handler: async (ctx) => {
      const entry = mustGetEntry(ctx.store, ctx.params["id"]!);
      deleteEntry(ctx.store, entry, ctx.now());
      return { body: { deleted: true, id: entry.id } };
    },
  },
  {
    method: "POST",
    path: "/api/entries/:id/pause",
    handler: async (ctx) => {
      const entry = mustGetEntry(ctx.store, ctx.params["id"]!);
      requireTransition(entry, "pause");
      const nowIso = ctx.now().toISOString();
      ctx.store.update("entries", entry.id, { status: "paused", updated_at: nowIso });
      ctx.store.addHistory({
        entity_type: "entry", entity_id: entry.id, action: "paused", actor: "user",
        summary: "paused tracking", details: null, at: nowIso,
      });
      return { body: { entry: { ...entry, status: "paused", updated_at: nowIso } } };
    },
  },
  {
    method: "POST",
    path: "/api/entries/:id/resume",
    handler: async (ctx) => {
      const entry = mustGetEntry(ctx.store, ctx.params["id"]!);
      requireTransition(entry, "resume");
      const nowIso = ctx.now().toISOString();
      ctx.store.update("entries", entry.id, { status: "active", updated_at: nowIso });
      ctx.store.addHistory({
        entity_type: "entry", entity_id: entry.id, action: "resumed", actor: "user",
        summary: "resumed tracking", details: null, at: nowIso,
      });
      return { body: { entry: { ...entry, status: "active", updated_at: nowIso } } };
    },
  },
  {
    method: "POST",
    path: "/api/entries/:id/withdraw",
    handler: async (ctx) => {
      const entry = mustGetEntry(ctx.store, ctx.params["id"]!);
      requireTransition(entry, "withdraw");
      const body = await readBody(ctx.req, withdrawRequestSchema);
      const stop = body.stop_preparation ?? true;
      const now = ctx.now();
      const nowIso = now.toISOString();
      const stopped: string[] = [];
      if (stop) {
        for (const p of linkedLivePreparations(ctx.store, entry.id)) {
          stopPreparation(ctx.store, p, now);
          stopped.push(p.id);
        }
      }
      expireSuggestionsForEntry(ctx.store, entry.id, now, "entry_withdrawn");
      const updated = { ...entry, status: "withdrawn" as const, updated_at: nowIso };
      ctx.store.update("entries", entry.id, { status: "withdrawn", updated_at: nowIso });
      ctx.store.addHistory({
        entity_type: "entry", entity_id: entry.id, action: "withdrawn", actor: "user",
        summary: "withdrawn; tracking stopped", details: { reason: body.reason ?? null, preparations_stopped: stopped }, at: nowIso,
      });
      return { body: { entry: updated, preparations_stopped: stopped } };
    },
  },
  {
    method: "POST",
    path: "/api/entries/:id/cancel-schedule",
    handler: async (ctx) => {
      const entry = mustGetEntry(ctx.store, ctx.params["id"]!);
      requireTransition(entry, "cancel_schedule");
      const body = await readBody(ctx.req, cancelScheduleRequestSchema);
      const now = ctx.now();
      const nowIso = now.toISOString();
      const context = entry.context as unknown as Record<string, unknown>;
      const updatedContext = { ...context, reschedule_allowed: false };
      ctx.store.update("entries", entry.id, {
        status: "cancelled",
        context: updatedContext,
        updated_at: nowIso,
      });
      ctx.store.addHistory({
        entity_type: "entry", entity_id: entry.id, action: "schedule_cancelled", actor: "user",
        summary: "schedule cancelled; never rescheduled",
        details: { reason: body.reason, reschedule_allowed: false }, at: nowIso,
      });
      for (const derived of ctx.store.list<Entry>("entries", [eq("derived_from_entry_id", entry.id)])) {
        expireSuggestionsForEntry(ctx.store, derived.id, now, "schedule_cancelled");
      }
      return {
        body: {
          entry: {
            ...entry,
            status: "cancelled" as const,
            context: updatedContext as unknown as Entry["context"],
            updated_at: nowIso,
          },
        },
      };
    },
  },
  {
    method: "POST",
    path: "/api/entries/:id/promote",
    handler: async (ctx) => {
      const entry = mustGetEntry(ctx.store, ctx.params["id"]!);
      if (entry.status === "withdrawn" || entry.status === "cancelled") {
        throw badRequest([{ path: "id", message: `cannot promote a ${entry.status} entry` }], "invalid source entry");
      }
      const body = await readBody(ctx.req, promoteRequestSchema);
      if (body.due_at !== undefined && body.due_at !== null) requireIso(body.due_at, "due_at");
      const created = promoteEntry(ctx.store, entry, body, ctx.now());
      return { status: 201, body: { source_entry: entry, created_entry: created } };
    },
  },
];
