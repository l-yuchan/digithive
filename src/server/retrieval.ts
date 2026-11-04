import type { Citation, Entry, QueryResponse, Source } from "../shared";
import type { DevelopmentRow, Store } from "./store";
import { effectiveReportStyle, type ReportStyle } from "./prefs";
import { matchedTokens, tokenize, type TokenSet } from "./text";
import { QUERY_LIMITATIONS } from "./llm";

// Grounded retrieval (R7): deterministic keyword matching over stored rows,
// template answers only, every claim pinned to a verbatim stored quote. The
// effective report_style preference (entry scope > global) changes the answer
// template depth and is exposed as `style` for honest inspection.

export interface StyledQueryResponse extends QueryResponse {
  style: ReportStyle;
}

interface RowMatch {
  entity_type: Citation["entity_type"];
  id: string;
  at: string;
  quote: string;
  tokens: TokenSet;
  matched: string[];
  rank: number;
  entry?: Entry;
  source?: Source;
  dev?: DevelopmentRow;
}

function tokensOfEntry(e: Entry): TokenSet {
  const ctx = e.context;
  const extra =
    ctx.kind === "interest"
      ? `${ctx.why_it_matters ?? ""} ${ctx.known_obstacle ?? ""}`
      : ctx.kind === "hypothesis"
        ? (ctx.falsifier ?? "")
        : ctx.kind === "delegation"
          ? ctx.scope
          : "";
  return tokenize(`${e.text} ${extra}`);
}

function minShared(questionSize: number): number {
  return questionSize <= 3 ? 1 : 2;
}

function cancelReason(store: Store, entryId: string): string | null {
  const events = store.list<{ details: Record<string, unknown> | null }>("history_events", [
    { sql: "entity_type = ?", params: ["entry"] },
    { sql: "entity_id = ?", params: [entryId] },
    { sql: "action = ?", params: ["schedule_cancelled"] },
  ]);
  const reason = events[0]?.details?.["reason"];
  return typeof reason === "string" ? reason : null;
}

function entryLine(store: Store, e: Entry): string {
  const provenance = e.provenance === "inferred" ? " (inferred, not confirmed)" : "";
  if (e.kind === "fact") return `fact: "${e.text}"${provenance}`;
  if (e.kind === "hypothesis") return `hypothesis: "${e.text}"${provenance} (tentative, not a decision)`;
  if (e.kind === "commitment") {
    const reason = e.status === "cancelled" ? cancelReason(store, e.id) : null;
    return `commitment: "${e.text}" (status ${e.status}${reason ? `, cancelled because: ${reason}` : ""})`;
  }
  if (e.kind === "delegation") return `delegation: "${e.text}" (status ${e.status})`;
  return `interest: "${e.text}"${provenance} (an interest, not a decision)`;
}

export function groundedQuery(
  store: Store,
  question: string,
  at: Date,
  prefs: import("../shared").Preference[],
): StyledQueryResponse {
  const style = effectiveReportStyle(prefs, "global");
  const qTokens = tokenize(question);
  const matches: RowMatch[] = [];
  const consider = (
    entity_type: RowMatch["entity_type"],
    id: string,
    createdAt: string,
    quote: string,
    tokens: TokenSet,
    extra?: Partial<RowMatch>,
  ) => {
    const matched = matchedTokens(qTokens, tokens);
    if (matched.length < minShared(qTokens.primary.size)) return;
    matches.push({
      entity_type,
      id,
      at: createdAt,
      quote,
      tokens,
      matched: matched.map((t) => qTokens.surface.get(t) ?? t),
      rank: matched.length / Math.max(1, qTokens.primary.size),
      ...extra,
    });
  };
  for (const e of store.list<Entry>("entries", [], { order: "created_at, id" })) {
    consider("entry", e.id, e.created_at, e.text, tokensOfEntry(e), { entry: e });
  }
  for (const s of store.list<Source>("sources", [], { order: "created_at, id" })) {
    consider("source", s.id, s.created_at, s.evidence_summary, tokenize(`${s.title} ${s.evidence_summary}`), {
      source: s,
    });
  }
  for (const d of store.list<DevelopmentRow>("developments", [], { order: "created_at, id" })) {
    consider("development", d.id, d.created_at, d.summary, tokenize(`${d.summary} ${d.content ?? ""}`), {
      dev: d,
    });
  }
  matches.sort((a, b) => b.rank - a.rank || (a.id < b.id ? -1 : 1));

  const facts = matches.filter((m) => m.entry?.kind === "fact");
  const statedFacts = facts.filter((m) => m.entry?.provenance === "user_stated");
  const anyInferred = matches.some((m) => m.entry?.provenance === "inferred");
  const epistemic_status: QueryResponse["epistemic_status"] =
    statedFacts.length === 0 ? "insufficient_record" : anyInferred ? "includes_inferences" : "recorded_facts";

  const shown =
    style === "summary_only"
      ? statedFacts
      : matches.slice(0, style === "concise_first" ? 3 : 10);
  const citations: Citation[] = shown.map((m) => ({
    entity_type: m.entity_type,
    entity_id: m.id,
    at: m.at,
    quote: m.quote,
  }));

  const lines: string[] = [];
  if (epistemic_status === "insufficient_record") {
    lines.push("No decision is recorded for this question.");
  } else {
    lines.push("Recorded facts:");
    for (const m of shown.filter((x) => x.entry?.kind === "fact")) {
      lines.push(`- ${entryLine(store, m.entry!)} (recorded ${m.at})`);
    }
  }
  if (style !== "summary_only") {
    const others = shown.filter((m) => m.entry && m.entry.kind !== "fact");
    if (others.length > 0) {
      lines.push("Also recorded (not decisions):");
      for (const m of others) lines.push(`- ${entryLine(store, m.entry!)}`);
    }
    const records = shown.filter((m) => m.source || m.dev);
    if (records.length > 0) {
      lines.push("Saved evidence:");
      for (const m of records) {
        if (m.source) lines.push(`- source "${m.source.title}": ${m.source.evidence_summary}`);
        if (m.dev) lines.push(`- development: "${m.dev.summary}"`);
      }
    }
  } else if (epistemic_status !== "insufficient_record") {
    lines.push(
      `(${facts.length} fact(s), ${matches.length - facts.length} non-decision record(s) matched; use detailed style for full listing)`,
    );
  }
  if (matches.length === 0) lines.push("Nothing in the saved records matches this question.");

  return {
    answer: lines.join("\n"),
    epistemic_status,
    citations,
    unpinned_claims: [],
    mode: "rules",
    limitations: QUERY_LIMITATIONS,
    style,
  };
}
