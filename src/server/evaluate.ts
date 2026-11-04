import type {
  EvaluationCondition,
  EvaluationEntry,
  HistoryEvent,
} from "../shared";
import type { Store } from "./store";
import { eq, gte, inCol, lte } from "./store";

export interface EvaluationSummary {
  from: string;
  to: string;
  days_logged: { baseline: number; secretary: number };
  components: {
    baseline: Record<string, number | null>;
    secretary: Record<string, number | null>;
  };
  net_time_saved_minutes: number | null;
  counts: {
    opportunities_offered: number;
    opportunities_accepted: number;
    missed_high_value: number;
    unwanted_interruptions: number;
    grounding_errors: number;
    corrections: number;
    cancellation_violations: number;
    approval_boundary_violations: number;
  };
  ratings: { usefulness: number | null; burden: number | null; control: number | null; confidence: number | null };
  critical_events: HistoryEvent[];
  missing_data: string[];
  disclaimer: string;
}

// n=1 daily-log summary (contract §10, lead override): baseline and secretary
// are compared as DAILY MEDIANS (robust to unequal day counts), and the
// secretary side includes management (assistant_management), verification
// (review_correction) and interruption-recovery costs. Missing components stay
// null and are never estimated.

export const N1_DISCLAIMER =
  "n=1 experience probe: these numbers describe one person's month and cannot " +
  "establish generalization, causality, or suitability for other users. Components, " +
  "misses, and critical events are reported raw; no benchmark claim is made.";

const EFFORT_KEYS = [
  "context_recovery_minutes",
  "search_minutes",
  "task_restart_minutes",
  "review_correction_minutes",
  "assistant_management_minutes",
  "interruption_recovery_minutes",
] as const;

const RATING_KEYS = ["usefulness_rating", "burden_rating", "control_rating", "confidence_rating"] as const;

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function summarize(store: Store, from: string, to: string): EvaluationSummary {
  const evals = store.list<EvaluationEntry>(
    "evaluations",
    [gte("date", from), lte("date", to)],
    { order: "date, condition, id" },
  );
  const of = (c: EvaluationCondition) => evals.filter((e) => e.condition === c);

  const components: EvaluationSummary["components"] = { baseline: {}, secretary: {} };
  for (const cond of ["baseline", "secretary"] as const) {
    for (const key of EFFORT_KEYS) {
      const vals = of(cond)
        .map((e) => e[key])
        .filter((v): v is number => v !== null);
      components[cond][key] = median(vals);
    }
  }

  const dailyTotals = (c: EvaluationCondition): number[] =>
    of(c)
      .filter((e) => EFFORT_KEYS.every((k) => e[k] !== null))
      .map((e) => EFFORT_KEYS.reduce((sum, k) => sum + (e[k] ?? 0), 0));
  const baselineTotals = dailyTotals("baseline");
  const secretaryTotals = dailyTotals("secretary");
  const net =
    baselineTotals.length > 0 && secretaryTotals.length > 0
      ? round1(median(baselineTotals)! - median(secretaryTotals)!)
      : null;

  const sumAll = (pick: (e: EvaluationEntry) => number): number =>
    evals.reduce((acc, e) => acc + pick(e), 0);
  const counts: EvaluationSummary["counts"] = {
    opportunities_offered: sumAll((e) => e.opportunities_offered),
    opportunities_accepted: sumAll((e) => e.opportunities_accepted),
    missed_high_value: sumAll((e) => e.missed_high_value),
    unwanted_interruptions: sumAll((e) => e.unwanted_interruptions),
    grounding_errors: sumAll((e) => e.grounding_errors),
    corrections: sumAll((e) => e.correction_events),
    cancellation_violations: sumAll((e) => e.cancellation_violations),
    approval_boundary_violations: sumAll((e) => e.approval_boundary_violations),
  };

  const ratingMedian = (key: (typeof RATING_KEYS)[number]): number | null =>
    median(
      evals
        .map((e) => e[key])
        .filter((v): v is number => v !== null),
    );
  const ratings: EvaluationSummary["ratings"] = {
    usefulness: ratingMedian("usefulness_rating"),
    burden: ratingMedian("burden_rating"),
    control: ratingMedian("control_rating"),
    confidence: ratingMedian("confidence_rating"),
  };

  // Critical gates: diary-observed grounding errors, cancellation violations
  // and approval-boundary violations are never averaged away.
  const violating = evals.filter(
    (e) =>
      e.cancellation_violations > 0 ||
      e.approval_boundary_violations > 0 ||
      e.grounding_errors > 0,
  );
  const critical_events =
    violating.length === 0
      ? []
      : store
          .list<HistoryEvent>(
            "history_events",
            [eq("entity_type", "evaluation"), inCol("entity_id", violating.map((e) => e.id))],
            { order: "at, id" },
          )
          .filter((h) => {
            const day = h.at.slice(0, 10);
            return day >= from && day <= to;
          });

  const missing_data: string[] = [];
  if (evals.length === 0) missing_data.push("no evaluation entries in range");
  for (const cond of ["baseline", "secretary"] as const) {
    for (const key of EFFORT_KEYS) {
      if (components[cond][key] === null) missing_data.push(`${cond}.${key}`);
    }
  }
  if (net === null) {
    if (baselineTotals.length === 0) missing_data.push("net_time_saved_minutes: no complete baseline days");
    if (secretaryTotals.length === 0) missing_data.push("net_time_saved_minutes: no complete secretary days");
  }

  return {
    from,
    to,
    days_logged: { baseline: of("baseline").length, secretary: of("secretary").length },
    components,
    net_time_saved_minutes: net,
    counts,
    ratings,
    critical_events,
    missing_data,
    disclaimer: N1_DISCLAIMER,
  };
}
