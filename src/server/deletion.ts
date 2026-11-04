import type { Entry, Preparation, Source } from "../shared";
import type { CalendarRow, DevelopmentRow, Store, SuggestionRow } from "./store";
import { eq, inCol } from "./store";

// R10: deletion actually removes content. Deleting an entry/source/development
// removes its content-bearing rows (suggestions, linked preparations, the
// entity's history) and purges any preparation outline that quotes the deleted
// text verbatim, keeping only a content-free "deleted" audit marker.
// Content-free triage events stay as the "why was this quiet" audit.

const MIN_QUOTE = 8;

function marker(store: Store, entity_type: "entry" | "source" | "development", id: string, what: string, now: Date): void {
  store.addHistory({
    entity_type,
    entity_id: id,
    action: "deleted",
    actor: "user",
    summary: `${what} deleted; content removed`,
    details: null,
    at: now.toISOString(),
  });
}

function deleteSuggestions(store: Store, suggestionIds: readonly string[]): void {
  if (suggestionIds.length === 0) return;
  store.removeWhere("suggestions", [inCol("id", suggestionIds)]);
  store.removeWhere("history_events", [
    eq("entity_type", "suggestion"),
    inCol("entity_id", suggestionIds),
  ]);
}

function deletePreparations(store: Store, ids: readonly string[], now: Date): void {
  for (const id of ids) {
    store.remove("preparations", id);
    store.addHistory({
      entity_type: "preparation",
      entity_id: id,
      action: "deleted",
      actor: "system_rules",
      summary: "linked preparation deleted with its anchor",
      details: null,
      at: now.toISOString(),
    });
  }
}

/** Removes preparations whose stored outline quotes deleted text verbatim. */
export function purgePreparationsQuoting(store: Store, texts: readonly (string | null)[], now: Date): void {
  const candidates = texts.filter((t): t is string => typeof t === "string" && t.length >= MIN_QUOTE);
  if (candidates.length === 0) return;
  for (const p of store.list<Preparation>("preparations")) {
    if (p.result_summary && candidates.some((t) => p.result_summary!.includes(t))) {
      deletePreparations(store, [p.id], now);
    }
  }
}

function entryTexts(entry: Entry): (string | null)[] {
  const ctx = entry.context;
  return [
    entry.text,
    entry.original_text,
    ctx.kind === "interest" ? ctx.why_it_matters : null,
    ctx.kind === "interest" ? ctx.known_obstacle : null,
    ctx.kind === "hypothesis" ? ctx.falsifier : null,
    ctx.kind === "delegation" ? ctx.scope : null,
  ];
}

export function deleteEntry(store: Store, entry: Entry, now: Date): void {
  const suggestions = store.list<SuggestionRow>("suggestions", [eq("entry_id", entry.id)]);
  const suggestionIds = suggestions.map((s) => s.id);
  const linkedPreps = store
    .list<Preparation>("preparations", [
      {
        sql: "delegation_id = ? OR suggestion_id IN (SELECT id FROM suggestions WHERE entry_id = ?)",
        params: [entry.id, entry.id],
      },
    ])
    .map((p) => p.id);
  deleteSuggestions(store, suggestionIds);
  deletePreparations(store, linkedPreps, now);
  purgePreparationsQuoting(store, entryTexts(entry), now);
  store.removeWhere("history_events", [eq("entity_type", "entry"), eq("entity_id", entry.id)]);
  store.remove("entries", entry.id);
  marker(store, "entry", entry.id, `entry (${entry.kind})`, now);
}

export function deleteDevelopment(store: Store, dev: DevelopmentRow, now: Date): void {
  const suggestions = store.list<SuggestionRow>("suggestions", [eq("development_id", dev.id)]);
  deleteSuggestions(store, suggestions.map((s) => s.id));
  purgePreparationsQuoting(store, [dev.summary, dev.content], now);
  store.removeWhere("history_events", [eq("entity_type", "development"), eq("entity_id", dev.id)]);
  store.remove("developments", dev.id);
  marker(store, "development", dev.id, "development", now);
}

export function deleteSource(store: Store, source: Source, now: Date): void {
  const developments = store.list<DevelopmentRow>("developments", [eq("source_id", source.id)]);
  const devIds = developments.map((d) => d.id);
  if (devIds.length > 0) {
    const suggestions = store.list<SuggestionRow>("suggestions", [inCol("development_id", devIds)]);
    deleteSuggestions(store, suggestions.map((s) => s.id));
    store.removeWhere("history_events", [
      eq("entity_type", "development"),
      inCol("entity_id", devIds),
    ]);
  }
  purgePreparationsQuoting(
    store,
    [source.title, source.evidence_summary, ...developments.flatMap((d) => [d.summary, d.content])],
    now,
  );
  store.removeWhere("developments", [eq("source_id", source.id)]);
  store.removeWhere("history_events", [eq("entity_type", "source"), eq("entity_id", source.id)]);
  store.remove("sources", source.id);
  marker(store, "source", source.id, "source", now);
}

/** Removing a subscription removes every occurrence it contributed. */
export function deleteCalendar(store: Store, calendar: CalendarRow, now: Date): void {
  store.removeWhere("calendar_events", [eq("calendar_id", calendar.id)]);
  store.removeWhere("history_events", [eq("entity_type", "calendar"), eq("entity_id", calendar.id)]);
  store.remove("calendars", calendar.id);
  store.addHistory({
    entity_type: "calendar",
    entity_id: calendar.id,
    action: "deleted",
    actor: "user",
    summary: `calendar subscription "${calendar.name}" deleted with its synced occurrences`,
    details: null,
    at: now.toISOString(),
  });
}

/** DELETE /api/data/all: drops every domain row and resets settings. */
export function wipeAllData(store: Store, defaultSettings: () => import("../shared").Settings): void {
  for (const table of [
    "entries",
    "preferences",
    "sources",
    "developments",
    "suggestions",
    "triage_events",
    "preparations",
    "history_events",
    "evaluations",
    "backup_snapshots",
    "calendar_events",
    "calendars",
  ] as const) {
    store.removeWhere(table, []);
  }
  store.saveSettings(defaultSettings());
}
