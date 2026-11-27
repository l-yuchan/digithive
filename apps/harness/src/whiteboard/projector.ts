import type { Database } from "bun:sqlite";
import {
  encodeDocument,
  listMarkdownFiles,
  readDocumentFile,
  removeDocumentFile,
  writeDocumentFile,
  type WhiteboardDraft,
} from "./document";
import { briefingDrafts, runDrafts, scheduleDrafts, workflowDrafts } from "./projection-work";
import { fileDrafts, memoryDrafts, syncDrafts } from "./projection-records";
import { conversationDrafts } from "./projection-conversations";
import type { WhiteboardSource } from "./types";

/** Source types this module owns; a file carrying any other type is manual. */
const OPERATIONAL_TYPES = new Set([
  "gmail",
  "calendar",
  "canvas",
  "file",
  "memory",
  "workflow",
  "run",
  "schedule",
  "briefing",
  "conversation",
]);

/** A stale file is removed only when its path namespace and source both match. */
const OWNED_PREFIXES: readonly { readonly prefix: string; readonly type: string }[] = [
  { prefix: "records/gmail/", type: "gmail" },
  { prefix: "records/calendar/", type: "calendar" },
  { prefix: "records/canvas/", type: "canvas" },
  { prefix: "records/files/", type: "file" },
  { prefix: "records/conversations/", type: "conversation" },
  { prefix: "threads/memories/", type: "memory" },
  { prefix: "threads/briefings/", type: "briefing" },
  { prefix: "commitments/workflows/", type: "workflow" },
  { prefix: "commitments/runs/", type: "run" },
  { prefix: "watches/schedules/", type: "schedule" },
];

function owns(relative: string, source: WhiteboardSource): boolean {
  const type = typeof source["type"] === "string" ? source["type"] : "";
  return OWNED_PREFIXES.some((entry) => relative.startsWith(entry.prefix) && entry.type === type);
}

function writeOwned(root: string, value: WhiteboardDraft): void {
  const content = encodeDocument(value);
  const existing = readDocumentFile(root, value.path);
  if (existing !== null) {
    const type = existing.document.source["type"];
    if (typeof type !== "string" || !OPERATIONAL_TYPES.has(type)) return;
    if (existing.raw === content) return;
  }
  writeDocumentFile(root, value.path, content);
}

/**
 * Materializes every operational source as deterministic Markdown. An existing
 * file whose source type is not an operational one is a manual document and wins
 * over the projection at the same path; a removed operational origin loses its file.
 */
export function projectOperationalDocuments(db: Database, root: string, now: number): void {
  const nowIso = new Date(now).toISOString();
  const drafts = [
    ...syncDrafts(db, nowIso),
    ...memoryDrafts(db, nowIso),
    ...fileDrafts(db, nowIso),
    ...workflowDrafts(db, nowIso),
    ...runDrafts(db, nowIso),
    ...scheduleDrafts(db, nowIso),
    ...briefingDrafts(db, nowIso),
    ...conversationDrafts(db, nowIso),
  ];
  const desired = new Set(drafts.map((value) => value.path));
  for (const relative of listMarkdownFiles(root)) {
    if (desired.has(relative)) continue;
    const existing = readDocumentFile(root, relative);
    if (existing !== null && owns(relative, existing.document.source))
      removeDocumentFile(root, relative);
  }
  for (const value of drafts) writeOwned(root, value);
}
