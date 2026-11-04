import type { EvaluationCondition, EvaluationEntry } from "../../shared";
import { badRequest, isLocalDate, type Route } from "../api_util";
import type { Store } from "../store";
import { summarize } from "../evaluate";

const CONDITIONS = ["baseline", "secretary"] as const;
const MINUTE_FIELDS = [
  "context_recovery_minutes", "search_minutes", "task_restart_minutes",
  "review_correction_minutes", "assistant_management_minutes", "interruption_recovery_minutes",
] as const;
const COUNT_FIELDS = [
  "opportunities_offered", "opportunities_accepted", "missed_high_value",
  "unwanted_interruptions", "grounding_errors", "correction_events",
  "cancellation_violations", "approval_boundary_violations",
] as const;
const RATING_FIELDS = ["usefulness_rating", "burden_rating", "control_rating", "confidence_rating"] as const;

/** Hand-written validator: the shared schema module has no evaluation schema.
 * Absent effort/rating components default to null (never zero, never estimated). */
function parseEvaluationInput(raw: unknown, path: string): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw badRequest([{ path, message: "a JSON object body is required" }]);
  }
  const body = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (body.condition !== "baseline" && body.condition !== "secretary") {
    throw badRequest([{ path: `${path}.condition`, message: "must be baseline or secretary" }]);
  }
  out.condition = body.condition;
  for (const f of MINUTE_FIELDS) {
    const v = body[f];
    if (v === undefined || v === null) {
      out[f] = null;
    } else {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        throw badRequest([{ path: `${path}.${f}`, message: "must be a number >= 0 or null" }]);
      }
      out[f] = v;
    }
  }
  for (const f of COUNT_FIELDS) {
    const v = body[f];
    if (v === undefined || v === null) {
      out[f] = 0;
    } else {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
        throw badRequest([{ path: `${path}.${f}`, message: "must be an integer >= 0" }]);
      }
      out[f] = v;
    }
  }
  for (const f of RATING_FIELDS) {
    const v = body[f];
    if (v === undefined || v === null) {
      out[f] = null;
    } else {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 5) {
        throw badRequest([{ path: `${path}.${f}`, message: "must be an integer 1..5 or null" }]);
      }
      out[f] = v;
    }
  }
  if (body.notes !== undefined && body.notes !== null && typeof body.notes !== "string") {
    throw badRequest([{ path: `${path}.notes`, message: "must be a string" }]);
  }
  out.notes = typeof body.notes === "string" ? body.notes : "";
  return out;
}

function buildEntry(
  store: Store,
  date: string,
  parsed: Record<string, unknown>,
  nowIso: string,
): EvaluationEntry {
  const existing = store.findEvaluation(date, parsed.condition as EvaluationCondition);
  const base = {
    id: existing?.id ?? crypto.randomUUID(),
    date,
    ...(parsed as unknown as Omit<EvaluationEntry, "id" | "date" | "created_at" | "updated_at">),
    created_at: existing?.created_at ?? nowIso,
    updated_at: nowIso,
  };
  return base as EvaluationEntry;
}

export const evaluationRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/evaluation/daily",
    handler: async (ctx) => {
      const date = ctx.url.searchParams.get("date");
      const condition = ctx.url.searchParams.get("condition");
      if (!date || !isLocalDate(date)) {
        throw badRequest([{ path: "date", message: "date (YYYY-MM-DD) is required" }]);
      }
      if (!condition || !CONDITIONS.includes(condition as EvaluationCondition)) {
        throw badRequest([{ path: "condition", message: "condition must be baseline or secretary" }]);
      }
      return { body: { entry: ctx.store.findEvaluation(date, condition) } };
    },
  },
  {
    method: "PUT",
    path: "/api/evaluation/daily/:date",
    handler: async (ctx) => {
      const date = ctx.params["date"]!;
      if (!isLocalDate(date)) throw badRequest([{ path: "date", message: "must be a YYYY-MM-DD date" }]);
      const raw = await ctx.req.json().catch(() => null);
      const parsed = parseEvaluationInput(raw, "body");
      const existing = ctx.store.findEvaluation(date, parsed.condition as EvaluationCondition);
      const entry = buildEntry(ctx.store, date, parsed, ctx.now().toISOString());
      ctx.store.upsertEvaluation(entry, ctx.now().toISOString());
      ctx.store.addHistory({
        entity_type: "evaluation", entity_id: entry.id,
        action: existing ? "updated" : "created", actor: "user",
        summary: `daily diary saved (${entry.condition}, ${entry.date})`,
        details: {
          date: entry.date,
          condition: entry.condition,
          grounding_errors: entry.grounding_errors,
          cancellation_violations: entry.cancellation_violations,
          approval_boundary_violations: entry.approval_boundary_violations,
        },
        at: ctx.now().toISOString(),
      });
      return { body: { entry } };
    },
  },
  {
    method: "GET",
    path: "/api/evaluation/summary",
    handler: async (ctx) => {
      const from = ctx.url.searchParams.get("from");
      const to = ctx.url.searchParams.get("to");
      if (!from || !isLocalDate(from)) throw badRequest([{ path: "from", message: "from (YYYY-MM-DD) is required" }]);
      if (!to || !isLocalDate(to)) throw badRequest([{ path: "to", message: "to (YYYY-MM-DD) is required" }]);
      if (from > to) throw badRequest([{ path: "to", message: "to must not precede from" }]);
      return { body: summarize(ctx.store, from, to) };
    },
  },
];
