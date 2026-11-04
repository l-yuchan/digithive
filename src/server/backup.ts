import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  BackupSnapshotInfo,
  Entry,
  ExportBundle,
  HistoryEvent,
  Preference,
  Preparation,
  Source,
  TriageEvent,
  EvaluationEntry,
} from "../shared";
import type { CalendarEventRow, CalendarRow, DevelopmentRow, Store, SuggestionRow } from "./store";
import { calendarEventView, calendarView, eq, suggestionView } from "./store";

// Durable export (full JSON bundle) and SQLite snapshots via VACUUM INTO.
// Restore (documented in .omo/handoffs/backend-done.md): stop the server, copy
// data/digithive.sqlite aside, then either point DIGITHIVE_DB at the snapshot
// file or copy it over data/digithive.sqlite and start again — the snapshot is
// a standalone SQLite database with the same schema and WAL handling.

export function buildExportBundle(store: Store, now: Date): ExportBundle {
  return {
    schema_version: 1,
    exported_at: now.toISOString(),
    settings: store.getSettings(),
    calendars: store
      .dump<CalendarRow>("calendars")
      .map((row) => calendarView(row, store.count("calendar_events", [eq("calendar_id", row.id)]))),
    calendar_events: store.dump<CalendarEventRow>("calendar_events").map(calendarEventView),
    entries: store.dump<Entry>("entries"),
    preferences: store.dump<Preference>("preferences"),
    sources: store.dump<Source>("sources"),
    developments: store.dump<DevelopmentRow>("developments"),
    suggestions: store.dump<SuggestionRow>("suggestions").map(suggestionView),
    preparations: store.dump<Preparation>("preparations"),
    triage_events: store.dump<TriageEvent>("triage_events"),
    history: store.dump<HistoryEvent>("history_events"),
    evaluations: store.dump<EvaluationEntry>("evaluations"),
  };
}

export function createSnapshot(store: Store, backupDir: string, now: Date): BackupSnapshotInfo {
  mkdirSync(backupDir, { recursive: true });
  const id = crypto.randomUUID();
  const file = `digithive-${now.toISOString().replace(/[:.]/g, "-")}-${id.slice(0, 8)}.sqlite`;
  const path = join(backupDir, file);
  store.db.run("VACUUM INTO ?", [path]);
  const info: BackupSnapshotInfo = {
    id,
    created_at: now.toISOString(),
    file_name: file,
    size_bytes: statSync(path).size,
  };
  store.insert("backup_snapshots", info);
  return info;
}
