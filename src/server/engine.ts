import type {
  Development,
  Entry,
  InterruptionPreference,
  Preference,
  Settings,
  Suggestion,
  TriageEvent,
  Uncertainty,
  WhyNow,
} from "../shared";
import type { DevelopmentRow, SuggestionRow, Store } from "./store";
import { eq, inCol } from "./store";
import { effectivePreference } from "./prefs";
import { tokenize, coverage, type TokenSet } from "./text";
import {
  activeFocusWindow,
  focusWindowEnd,
  nextDigestBoundary,
  quietActive,
} from "./time";

// Deterministic triage + delivery (contract R4-R6, R9). All thresholds and the
// delivery precedence live here; every decision is a pure function of stored
// rows and the injected clock.

export const RELEVANCE_MIN = 0.15; // Gate A: share of entry terms the development touches
export const OBSTACLE_MIN = 0.25; // Gate B: share of the obstacle the development addresses
export const STRONG_THRESHOLD = 0.35; // mean of Gate A and Gate B coverage

const CANDIDATE_KINDS = ["interest", "hypothesis"] as const;
const LIVE_SUGGESTION_STATES = ["queued", "held", "surfaced", "deferred"] as const;
/** Hold reasons that may later release; never/proactivity holds are permanent. */
const RELEASABLE_REASONS = new Set(["quiet", "digest", "focus", "interruption_digest"]);

export interface Delivery {
  status: "surfaced" | "held";
  hold_until: string | null;
  hold_reason: string | null;
}

export function devTokenSet(dev: DevelopmentRow): TokenSet {
  return tokenize(`${dev.summary} ${dev.content ?? ""}`);
}

export function entryTokenSet(entry: Entry): TokenSet {
  const ctx = entry.context;
  const extra =
    ctx.kind === "interest"
      ? `${ctx.why_it_matters ?? ""} ${ctx.known_obstacle ?? ""}`
      : ctx.kind === "hypothesis"
        ? (ctx.falsifier ?? "")
        : "";
  return tokenize(`${entry.text} ${extra}`);
}

/** Interest obstacle, or the falsifier as the hypothesis' obstacle-analog. */
export function obstacleTokenSet(entry: Entry): TokenSet {
  const ctx = entry.context;
  if (ctx.kind === "interest") return tokenize(ctx.known_obstacle);
  if (ctx.kind === "hypothesis") return tokenize(ctx.falsifier);
  return tokenize(null);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function uncertaintyOf(linked: boolean, bRatio: number, strong: boolean): Uncertainty {
  if (!strong) return "high";
  if (linked || bRatio >= 0.5) return "low";
  return "medium";
}

function buildWhyNow(
  entry: Entry,
  dev: DevelopmentRow,
  entryTokens: TokenSet,
  obstacleTokens: TokenSet,
  linked: boolean,
  bRatio: number,
  strong: boolean,
): WhyNow {
  const obstacleText =
    entry.context.kind === "interest"
      ? entry.context.known_obstacle
      : entry.context.kind === "hypothesis"
        ? entry.context.falsifier
        : null;
  const matchedA = coverage(entryTokens, devTokenSet(dev)).matched.map(
    (t) => entryTokens.surface.get(t) ?? t,
  );
  const matchedB = coverage(obstacleTokens, devTokenSet(dev)).matched.map(
    (t) => obstacleTokens.surface.get(t) ?? t,
  );
  const matched = [...new Set([...matchedA, ...matchedB])];
  const uncertainty = uncertaintyOf(linked, bRatio, strong);
  const timeNote =
    dev.time_sensitivity === "time_sensitive" && dev.deadline
      ? ` 기한이 있는 정보이며 마감은 ${dev.deadline}입니다.`
      : "";
  return {
    obstacle_link: obstacleText
      ? `기록된 장애물: "${obstacleText}"`
      : "직접 연결한 장애물 관계(저장된 장애물 문구 없음)",
    evidence_summary: dev.summary,
    source_id: dev.source_id,
    matched_terms: matched,
    uncertainty,
    explanation:
      `새 근거는 저장된 ${entry.kind} "${entry.text}"의 장애물과 연결될 수 있습니다. ` +
      `근거: "${dev.summary}".` +
      (matched.length > 0 ? ` 일치어: ${matched.join(", ")}.` : "") +
      ` 이 판단은 결정적 단어 겹침 점수이며 불확실성은 ${uncertainty}입니다.` +
      timeNote,
  };
}

/** R5 delivery precedence: quiet > interruption=never > focus (time-sensitivity
 * may override focus, nothing else — invariant 7) > interruption=digest_only >
 * immediate (overrides digest delivery) > delivery=digest > surfaced. A scoped
 * proactivity="off" preference holds anything that would otherwise surface. */
export function decideDelivery(
  entry: Entry,
  dev: Development,
  settings: Settings,
  prefs: Preference[],
  now: Date,
): Delivery {
  const held = (hold_until: string | null, hold_reason: string): Delivery => ({
    status: "held",
    hold_until,
    hold_reason,
  });
  const surfacing = (): Delivery => {
    const proactivity = effectivePreference(prefs, "proactivity", entry.scope, "suggestions_only");
    if (proactivity === "off") return held(null, "proactivity_off");
    return { status: "surfaced", hold_until: null, hold_reason: null };
  };
  if (quietActive(settings, now)) return held(null, "quiet");
  const fallback: InterruptionPreference =
    entry.kind === "interest" && entry.context.kind === "interest"
      ? entry.context.interruption
      : "when_strong";
  const interruption = effectivePreference(prefs, "interruption", entry.scope, fallback);
  if (interruption === "never") return held(null, "interruption_never");
  const focus = activeFocusWindow(now, settings);
  if (focus && dev.time_sensitivity !== "time_sensitive") {
    return held(focusWindowEnd(now, settings.timezone, focus).toISOString(), "focus");
  }
  if (interruption === "immediate") return surfacing();
  if (interruption === "digest_only") {
    return held(nextDigestBoundary(now, settings).toISOString(), "interruption_digest");
  }
  const delivery = effectivePreference(prefs, "delivery", entry.scope, settings.delivery);
  if (delivery === "digest") return held(nextDigestBoundary(now, settings).toISOString(), "digest");
  return surfacing();
}

function createSuggestion(
  store: Store,
  entry: Entry,
  dev: DevelopmentRow,
  strong: boolean,
  score: number,
  entryTokens: TokenSet,
  obstacleTokens: TokenSet,
  linked: boolean,
  bRatio: number,
  delivery: Delivery,
  now: Date,
): Suggestion {
  const nowIso = now.toISOString();
  const row: SuggestionRow = {
    id: crypto.randomUUID(),
    entry_id: entry.id,
    development_id: dev.id,
    status: strong ? delivery.status : "queued",
    strength: strong ? "strong" : "weak",
    score,
    matcher: "rules",
    why_now: buildWhyNow(entry, dev, entryTokens, obstacleTokens, linked, bRatio, strong),
    hold_until: strong ? delivery.hold_until : null,
    surfaced_at: strong && delivery.status === "surfaced" ? nowIso : null,
    response: null,
    created_at: nowIso,
    updated_at: nowIso,
    hold_reason: strong ? delivery.hold_reason : null,
  };
  store.insert("suggestions", row);
  store.addHistory({
    entity_type: "suggestion",
    entity_id: row.id,
    action: row.status,
    actor: "system_rules",
    summary: `${row.status} suggestion for entry ${entry.id} / development ${dev.id} (score ${score})`,
    details: { strength: row.strength, score, reason: delivery.hold_reason },
    at: nowIso,
  });
  const { hold_reason: _r, ...view } = row;
  return view;
}

export interface TriageOutcome {
  suggestions: Suggestion[];
  triage_events: TriageEvent[];
}

/** R4: runs on development create, against every stored interest/hypothesis. */
export function runTriage(store: Store, dev: DevelopmentRow, now: Date): TriageOutcome {
  const devTokens = devTokenSet(dev);
  const settings = store.getSettings();
  const prefs = store.list<Preference>("preferences");
  const suggestions: Suggestion[] = [];
  const triage_events: TriageEvent[] = [];
  const record = (
    outcome: TriageEvent["outcome"],
    reason: string,
    entryId: string,
    score: number,
  ): TriageEvent => {
    const ev: TriageEvent = {
      id: crypto.randomUUID(),
      development_id: dev.id,
      entry_id: entryId,
      outcome,
      reason,
      score,
      at: now.toISOString(),
    };
    store.insert("triage_events", ev);
    triage_events.push(ev);
    return ev;
  };
  const candidates = store.list<Entry>("entries", [inCol("kind", CANDIDATE_KINDS)], {
    order: "created_at, id",
  });
  for (const entry of candidates) {
    if (entry.status === "paused") {
      record("suppressed", "entry_paused", entry.id, 0);
      continue;
    }
    if (entry.status === "withdrawn") {
      record("suppressed", "entry_withdrawn", entry.id, 0);
      continue;
    }
    const prior = store.list<SuggestionRow>("suggestions", [
      eq("entry_id", entry.id),
      eq("development_id", dev.id),
    ]);
    if (prior.some((s) => s.status === "dismissed")) {
      record("suppressed", "dismissed_pair", entry.id, 0);
      continue;
    }
    if (prior.length > 0) {
      record("suppressed", "duplicate", entry.id, 0);
      continue;
    }
    const cancelledDerivative = store.count("entries", [
      eq("derived_from_entry_id", entry.id),
      eq("kind", "commitment"),
      eq("status", "cancelled"),
    ]);
    if (cancelledDerivative > 0) {
      record("suppressed", "schedule_cancelled", entry.id, 0);
      continue;
    }
    const entryTokens = entryTokenSet(entry);
    const obstacleTokens = obstacleTokenSet(entry);
    const linked = dev.addresses_obstacle_entry_ids.includes(entry.id);
    const a = coverage(entryTokens, devTokens);
    const b = linked ? { ratio: 1, matched: [] } : coverage(obstacleTokens, devTokens);
    const score = round2((a.ratio + b.ratio) / 2);
    if (a.ratio < RELEVANCE_MIN) {
      record("suppressed", "below_threshold", entry.id, score);
      continue;
    }
    if (b.ratio < OBSTACLE_MIN) {
      record("queued_weak", "no_obstacle_link", entry.id, score);
      suggestions.push(
        createSuggestion(store, entry, dev, false, score, entryTokens, obstacleTokens, linked, b.ratio, { status: "held", hold_until: null, hold_reason: null }, now),
      );
      continue;
    }
    if (score < STRONG_THRESHOLD) {
      record("queued_weak", "below_strong_threshold", entry.id, score);
      suggestions.push(
        createSuggestion(store, entry, dev, false, score, entryTokens, obstacleTokens, linked, b.ratio, { status: "held", hold_until: null, hold_reason: null }, now),
      );
      continue;
    }
    const delivery = decideDelivery(entry, dev, settings, prefs, now);
    record(delivery.status === "surfaced" ? "suggested" : "held", delivery.status, entry.id, score);
    suggestions.push(
      createSuggestion(store, entry, dev, true, score, entryTokens, obstacleTokens, linked, b.ratio, delivery, now),
    );
  }
  return { suggestions, triage_events };
}

function surfaceSuggestion(store: Store, s: SuggestionRow, now: Date): void {
  const nowIso = now.toISOString();
  store.update("suggestions", s.id, { status: "surfaced", surfaced_at: nowIso, updated_at: nowIso });
  store.addHistory({
    entity_type: "suggestion",
    entity_id: s.id,
    action: "surfaced",
    actor: "system_rules",
    summary: `suggestion ${s.id} released from hold (${s.hold_reason ?? "held"})`,
    details: { prior_status: s.status, hold_reason: s.hold_reason },
    at: nowIso,
  });
}

function expireSuggestion(store: Store, s: SuggestionRow, now: Date, reason: string): void {
  const nowIso = now.toISOString();
  store.update("suggestions", s.id, { status: "expired", updated_at: nowIso });
  store.addHistory({
    entity_type: "suggestion",
    entity_id: s.id,
    action: "expired",
    actor: "system_rules",
    summary: `suggestion ${s.id} expired (${reason})`,
    details: { reason },
    at: nowIso,
  });
}

/** Withdrawn/cancelled state governs suggestions immediately. */
export function expireSuggestionsForEntry(store: Store, entryId: string, now: Date, reason: string): void {
  const live = store.list<SuggestionRow>("suggestions", [
    eq("entry_id", entryId),
    inCol("status", LIVE_SUGGESTION_STATES),
  ]);
  for (const s of live) expireSuggestion(store, s, now, reason);
}

/** Releases due held/deferred suggestions. Manual quiet mode blocks every
 * release — opening the digest never auto-releases it; only the quiet_until
 * deadline (a timed quiet the user chose) or an explicit settings PATCH does. */
export function releasePass(store: Store, now: Date): void {
  const settings = store.getSettings();
  if (quietActive(settings, now)) return;
  const prefs = store.list<Preference>("preferences");
  const pending = store.list<SuggestionRow>("suggestions", [inCol("status", ["held", "deferred"])]);
  for (const s of pending) {
    const entry = store.byId<Entry>("entries", s.entry_id);
    if (!entry || entry.status === "withdrawn") {
      expireSuggestion(store, s, now, "entry_withdrawn");
      continue;
    }
    if (entry.status !== "active") continue;
    if (s.status === "deferred") {
      if (s.hold_until && now.getTime() >= Date.parse(s.hold_until)) surfaceSuggestion(store, s, now);
      continue;
    }
    const reason = s.hold_reason ?? "quiet";
    if (reason === "quiet") {
      const dev = store.byId<DevelopmentRow>("developments", s.development_id);
      if (!dev) continue;
      const redeliver = decideDelivery(entry, dev, { ...settings, quiet_mode: false }, prefs, now);
      if (redeliver.status === "surfaced") surfaceSuggestion(store, s, now);
      else {
        store.update("suggestions", s.id, {
          status: "held",
          hold_until: redeliver.hold_until,
          hold_reason: redeliver.hold_reason,
          updated_at: now.toISOString(),
        });
      }
      continue;
    }
    if (RELEASABLE_REASONS.has(reason) && s.hold_until && now.getTime() >= Date.parse(s.hold_until)) {
      surfaceSuggestion(store, s, now);
    }
  }
}
