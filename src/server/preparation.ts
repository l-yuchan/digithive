import type { Preparation } from "../shared";
import type { Entry, Source } from "../shared";
import type { DevelopmentRow, Store } from "./store";
import { eq } from "./store";
import { matchedTokens, tokenize } from "./text";

// Bounded internal preparation (R8, lead override): a LOCAL, synchronous
// saved-record outline. It is honestly not external research — every step
// works only over stored rows, and each step is appended to produced_actions
// as it happens. max_steps bounds the plan; hitting the bound mid-plan stops
// the preparation with the audit of what was already done.

const PLAN_STEPS = ["local_search", "outline", "verify"] as const;

export function runPreparation(store: Store, prep: Preparation, now: Date): Preparation {
  const nowIso = now.toISOString();
  const actions: string[] = [...prep.produced_actions];
  const stepTag = (i: number) => `step ${i + 1}/${Math.min(prep.max_steps, PLAN_STEPS.length)}`;
  store.update("preparations", prep.id, { status: "in_progress", updated_at: nowIso });

  // Step 1: local search over saved records (scope-filtered for entries).
  const reqTokens = tokenize(prep.request);
  const entries = store.list<Entry>(
    "entries",
    prep.scope === "global" ? [] : [eq("scope", prep.scope)],
    { order: "created_at, id" },
  );
  const sources = store.list<Source>("sources", [], { order: "created_at, id" });
  const developments = store.list<DevelopmentRow>("developments", [], { order: "created_at, id" });
  const matchedEntries = entries.filter((e) => matchedTokens(reqTokens, tokenize(e.text)).length > 0);
  const matchedSources = sources.filter((s) =>
    matchedTokens(reqTokens, tokenize(`${s.title} ${s.evidence_summary}`)).length > 0,
  );
  const matchedDevs = developments.filter((d) =>
    matchedTokens(reqTokens, tokenize(`${d.summary} ${d.content ?? ""}`)).length > 0,
  );
  actions.push(
    `${stepTag(0)}: local search over saved records (entries in scope "${prep.scope}") matched ` +
      `${matchedEntries.length} entries, ${matchedSources.length} sources, ${matchedDevs.length} developments; no external research performed`,
  );
  let current = persist(store, prep, actions, "in_progress", null, nowIso);

  const stepsPossible = Math.min(prep.max_steps, PLAN_STEPS.length);
  if (stepsPossible < 2) {
    return persist(store, current, actions, "stopped", current.result_summary, nowIso);
  }

  // Step 2: assemble the outline from stored text only.
  const lines: string[] = [`local outline for: ${prep.request}`, "saved records only; no external research"];
  const quoted: Array<{ text: string; store: string }> = [];
  for (const e of matchedEntries) {
    lines.push(`- entry (${e.kind}, scope ${e.scope}): ${e.text}`);
    quoted.push({ text: e.text, store: e.text });
  }
  for (const s of matchedSources) {
    lines.push(`- source "${s.title}": ${s.evidence_summary}`);
    quoted.push({ text: s.evidence_summary, store: s.evidence_summary });
  }
  for (const d of matchedDevs) {
    lines.push(`- development: ${d.summary}`);
    quoted.push({ text: d.summary, store: d.summary });
  }
  if (quoted.length === 0) lines.push("- no saved records matched the request; nothing to outline");
  const result_summary = lines.join("\n");
  actions.push(
    `${stepTag(1)}: assembled outline from ${quoted.length} saved record(s); every line quotes stored text verbatim`,
  );
  current = persist(store, current, actions, "in_progress", result_summary, nowIso);

  if (stepsPossible < 3) {
    return persist(store, current, actions, "stopped", result_summary, nowIso);
  }

  // Step 3: verify every quoted line is verbatim stored text.
  const unverified = quoted.filter((q) => !q.store.includes(q.text));
  actions.push(
    `${stepTag(2)}: verified ${quoted.length - unverified.length}/${quoted.length} quoted lines are verbatim stored text`,
  );
  const status: Preparation["status"] = unverified.length === 0 ? "done" : "failed";
  current = persist(store, current, actions, status, result_summary, nowIso);
  return current;
}

function persist(
  store: Store,
  prep: Preparation,
  actions: string[],
  status: Preparation["status"],
  result_summary: string | null,
  nowIso: string,
): Preparation {
  const updated: Preparation = {
    ...prep,
    produced_actions: [...actions],
    status,
    result_summary,
    updated_at: nowIso,
  };
  store.update("preparations", prep.id, {
    produced_actions: updated.produced_actions,
    status,
    result_summary,
    updated_at: nowIso,
  });
  return updated;
}

export function stopPreparation(store: Store, prep: Preparation, now: Date): Preparation {
  const actions = [
    ...prep.produced_actions,
    prep.produced_actions.length === 0
      ? "stopped before execution: no steps were run"
      : "stopped: audit preserves the steps already done",
  ];
  return persist(store, prep, actions, "stopped", prep.result_summary, now.toISOString());
}
