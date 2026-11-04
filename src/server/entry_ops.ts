import type { Entry, EntryContext, EntryKind, Id } from "../shared";
import type { Store } from "./store";
import { badRequest, invalidTransition, isIsoDateTime } from "./api_util";
import { expireSuggestionsForEntry } from "./engine";

// Entry lifecycle operations shared by the entries routes, promotion and
// suggestion responses: context defaults (server-filled per contract R1),
// creation, correction (R2) and the state machine (R3).

const CONTEXT_KEYS: Record<EntryKind, readonly string[]> = {
  interest: ["kind", "why_it_matters", "known_obstacle", "interruption"],
  fact: ["kind", "decided_at"],
  hypothesis: ["kind", "falsifier"],
  commitment: ["kind", "due_at", "scheduled_start", "scheduled_end", "reschedule_allowed"],
  delegation: ["kind", "scope", "max_steps", "local_only"],
};

/** Server-fills context defaults before schema validation. */
export function fillContextDefaults(raw: Record<string, unknown>): Record<string, unknown> {
  const kind = raw["kind"];
  const rawContext = raw["context"];
  const context: Record<string, unknown> =
    rawContext !== null && rawContext !== undefined && typeof rawContext === "object"
      ? { ...(rawContext as Record<string, unknown>) }
      : { kind };
  if (context.kind !== undefined && context.kind !== kind) {
    throw badRequest([{ path: "context.kind", message: "context kind must match entry kind" }]);
  }
  const c: Record<string, unknown> = { ...context, kind };
  if (kind === "interest") {
    if (c.interruption === undefined) c.interruption = "when_strong";
    if (c.why_it_matters === undefined) c.why_it_matters = null;
    if (c.known_obstacle === undefined) c.known_obstacle = null;
  } else if (kind === "fact") {
    if (c.decided_at === undefined) c.decided_at = null;
  } else if (kind === "hypothesis") {
    if (c.falsifier === undefined) c.falsifier = null;
  } else if (kind === "commitment") {
    if (c.due_at === undefined) c.due_at = null;
    if (c.scheduled_start === undefined) c.scheduled_start = null;
    if (c.scheduled_end === undefined) c.scheduled_end = null;
    if (c.reschedule_allowed === undefined) c.reschedule_allowed = true;
  } else if (kind === "delegation") {
    if (c.max_steps === undefined) c.max_steps = 3;
    if (c.local_only === undefined) c.local_only = true;
  }
  return { ...raw, context: c };
}

/** Validates partial-context keys against the entry's kind (R1/R2). */
export function checkContextKeys(kind: EntryKind, patch: Record<string, unknown>): void {
  const allowed = CONTEXT_KEYS[kind];
  for (const key of Object.keys(patch)) {
    if (!allowed.includes(key)) {
      throw badRequest([{ path: `context.${key}`, message: `context key "${key}" is not valid for kind "${kind}"` }]);
    }
  }
}

const INTERRUPTIONS = ["never", "digest_only", "when_strong", "immediate"] as const;

/** Validates and cleans a partial context patch for the entry's kind (R2). */
export function validateContextPatch(
  entry: Entry,
  patch: Record<string, unknown>,
): Partial<EntryContext> | undefined {
  if (Object.keys(patch).length === 0) return undefined;
  checkContextKeys(entry.kind, patch);
  if ("kind" in patch && patch["kind"] !== entry.kind) {
    throw badRequest([
      { path: "context.kind", message: "kind cannot be changed by correction (use promote)" },
    ]);
  }
  const out: Record<string, unknown> = {};
  const textOrNull = (v: unknown, path: string): string | null => {
    if (v === null || typeof v === "string") return v;
    throw badRequest([{ path: `context.${path}`, message: "must be a string or null" }]);
  };
  const isoOrNull = (v: unknown, path: string): string | null => {
    if (v === null) return null;
    if (!isIsoDateTime(v)) {
      throw badRequest([{ path: `context.${path}`, message: "must be an ISO-8601 datetime or null" }]);
    }
    return v;
  };
  if (entry.kind === "interest") {
    if ("why_it_matters" in patch) out["why_it_matters"] = textOrNull(patch["why_it_matters"], "why_it_matters");
    if ("known_obstacle" in patch) out["known_obstacle"] = textOrNull(patch["known_obstacle"], "known_obstacle");
    if ("interruption" in patch) {
      if (!INTERRUPTIONS.includes(patch["interruption"] as (typeof INTERRUPTIONS)[number])) {
        throw badRequest([{ path: "context.interruption", message: `must be one of ${INTERRUPTIONS.join(", ")}` }]);
      }
      out["interruption"] = patch["interruption"];
    }
  } else if (entry.kind === "fact") {
    if ("decided_at" in patch) out["decided_at"] = isoOrNull(patch["decided_at"], "decided_at");
  } else if (entry.kind === "hypothesis") {
    if ("falsifier" in patch) out["falsifier"] = textOrNull(patch["falsifier"], "falsifier");
  } else if (entry.kind === "commitment") {
    for (const k of ["due_at", "scheduled_start", "scheduled_end"] as const) {
      if (k in patch) out[k] = isoOrNull(patch[k], k);
    }
    if ("reschedule_allowed" in patch) {
      if (typeof patch["reschedule_allowed"] !== "boolean") {
        throw badRequest([{ path: "context.reschedule_allowed", message: "must be a boolean" }]);
      }
      out["reschedule_allowed"] = patch["reschedule_allowed"];
    }
  } else if (entry.kind === "delegation") {
    if ("scope" in patch) {
      if (typeof patch["scope"] !== "string" || !patch["scope"].trim()) {
        throw badRequest([{ path: "context.scope", message: "must be a non-empty string" }]);
      }
      out["scope"] = patch["scope"];
    }
    if ("max_steps" in patch) {
      const n = patch["max_steps"];
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 10) {
        throw badRequest([{ path: "context.max_steps", message: "must be an integer 1..10" }]);
      }
      out["max_steps"] = n;
    }
    if ("local_only" in patch) {
      if (patch["local_only"] !== true) {
        throw badRequest([{ path: "context.local_only", message: "must be literal true" }]);
      }
      out["local_only"] = true;
    }
  }
  return out as Partial<EntryContext>;
}

export interface CreateEntryArgs {
  kind: EntryKind;
  text: string;
  context: EntryContext;
  source_ids?: Id[];
  scope?: string;
  derived_from_entry_id?: Id | null;
}

export function createEntry(store: Store, args: CreateEntryArgs, now: Date): Entry {
  const nowIso = now.toISOString();
  const entry: Entry = {
    id: crypto.randomUUID(),
    kind: args.kind,
    text: args.text,
    original_text: args.text,
    status: "active",
    provenance: "user_stated",
    context: args.context,
    source_ids: args.source_ids ?? [],
    derived_from_entry_id: args.derived_from_entry_id ?? null,
    created_at: nowIso,
    updated_at: nowIso,
    version: 1,
    scope: args.scope ?? "global",
  };
  store.insert("entries", entry);
  store.addHistory({
    entity_type: "entry",
    entity_id: entry.id,
    action: "created",
    actor: "user",
    summary: `created ${entry.kind} entry`,
    details: { kind: entry.kind, scope: entry.scope, derived_from_entry_id: entry.derived_from_entry_id },
    at: nowIso,
  });
  return entry;
}

export interface CorrectionArgs {
  text?: string;
  context?: Partial<EntryContext>;
  correction_note?: string;
}

/** R2: original_text is preserved, version bumps, history records the note. */
export function applyCorrection(store: Store, entry: Entry, args: CorrectionArgs, now: Date): Entry {
  const nowIso = now.toISOString();
  const contextPatch = (args.context ?? {}) as Record<string, unknown>;
  const merged = { ...((entry.context as unknown as Record<string, unknown>)), ...contextPatch, kind: entry.kind };
  const updated: Entry = {
    ...entry,
    text: args.text ?? entry.text,
    context: merged as unknown as EntryContext,
    version: entry.version + 1,
    updated_at: nowIso,
  };
  store.update("entries", entry.id, {
    text: updated.text,
    context: updated.context,
    version: updated.version,
    updated_at: nowIso,
  });
  expireSuggestionsForEntry(store, entry.id, now, "entry_corrected");
  store.addHistory({
    entity_type: "entry",
    entity_id: entry.id,
    action: "corrected",
    actor: "user",
    summary: `corrected entry (version ${updated.version})`,
    details: {
      correction_note: args.correction_note ?? null,
      fields: [...(args.text !== undefined ? ["text"] : []), ...Object.keys(contextPatch)],
    },
    at: nowIso,
  });
  return updated;
}

/** Promotion (R1): a NEW entry of the target kind, linked to its source. */
export interface PromoteArgs {
  to: "commitment" | "delegation";
  text?: string | undefined;
  due_at?: string | null | undefined;
  scope?: string | undefined;
  max_steps?: number | undefined;
}

export function promoteEntry(
  store: Store,
  source: Entry,
  req: PromoteArgs,
  now: Date,
): Entry {
  const context: EntryContext =
    req.to === "commitment"
      ? {
          kind: "commitment",
          due_at: req.due_at ?? null,
          scheduled_start: null,
          scheduled_end: null,
          reschedule_allowed: true,
        }
      : { kind: "delegation", scope: req.scope ?? "", max_steps: req.max_steps ?? 3, local_only: true };
  const created = createEntry(
    store,
    {
      kind: req.to,
      text: req.text ?? source.text,
      context,
      source_ids: source.source_ids,
      scope: source.scope,
      derived_from_entry_id: source.id,
    },
    now,
  );
  store.addHistory({
    entity_type: "entry",
    entity_id: source.id,
    action: "promoted",
    actor: "user",
    summary: `promoted to ${req.to} as a new linked entry`,
    details: { created_entry_id: created.id, to: req.to },
    at: now.toISOString(),
  });
  return created;
}

const TRANSITIONS: Record<EntryKind, Record<string, readonly string[]>> = {
  interest: { pause: ["active"], resume: ["paused"], withdraw: ["active", "paused"], cancel_schedule: [] },
  fact: { pause: [], resume: [], withdraw: ["active"], cancel_schedule: [] },
  hypothesis: { pause: [], resume: [], withdraw: ["active"], cancel_schedule: [] },
  commitment: {
    pause: ["active"],
    resume: ["paused"],
    withdraw: ["active", "paused"],
    cancel_schedule: ["active", "paused"],
  },
  delegation: { pause: ["active"], resume: ["paused"], withdraw: ["active", "paused"], cancel_schedule: [] },
};

export function requireTransition(entry: Entry, op: "pause" | "resume" | "withdraw" | "cancel_schedule"): void {
  const allowed = TRANSITIONS[entry.kind][op] ?? [];
  if (!allowed.includes(entry.status)) {
    throw invalidTransition(`${op} is not allowed for a ${entry.kind} in status ${entry.status}`);
  }
}
