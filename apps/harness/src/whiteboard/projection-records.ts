import type { Database } from "bun:sqlite";
import { documentIdForOrigin, type WhiteboardDraft } from "./document";
import { datedPath, draft, iso, parseJson } from "./projection-format";

/** The biome-first group each collected source lives under (2026-11-28 layout). */
const RECORD_GROUPS: Readonly<Record<string, string>> = {
  gmail: "records/inbox",
  calendar: "records/calendar",
  canvas: "records/courses",
};

/** LMS items carry "과목 <name>" in their detail; that name becomes the course folder. */
function courseOf(detail: string | null): string | null {
  const match = /^과목\s+(.+?)\s+·/.exec(detail ?? "") ?? /^과목\s+(.+)$/.exec(detail ?? "");
  const name = match?.[1]?.trim() ?? "";
  return name.length > 0 && name !== "-" ? name : null;
}

type SyncRow = {
  account_id: string;
  source: string;
  item_id: string;
  title: string;
  at: string | null;
  detail: string | null;
  url: string | null;
  updated_at: string;
  label: string;
};

/** Enabled Gmail/Calendar/Canvas rows only; a disabled source never materializes. */
export function syncDrafts(db: Database, nowIso: string): WhiteboardDraft[] {
  const rows = db
    .query<SyncRow, []>(
      `SELECT i.account_id,i.source,i.item_id,i.title,i.at,i.detail,i.url,i.updated_at,a.label
         FROM sync_items i
         JOIN account_sources s ON s.account_id=i.account_id AND s.source=i.source
         JOIN integration_accounts a ON a.id=i.account_id
        WHERE s.enabled = 1 AND i.source IN ('gmail','calendar','canvas')
        ORDER BY i.source, i.at, i.item_id`,
    )
    .all();
  return rows.map((row) => {
    const group = RECORD_GROUPS[row.source] ?? `records/${row.source}`;
    return draft({
      originKey: `sync:${row.source}:${row.account_id}:${row.item_id}`,
      directory: group,
      leaf: datedPath({
        group,
        title: row.title,
        at: row.at,
        id: documentIdForOrigin(`sync:${row.source}:${row.account_id}:${row.item_id}`),
        course: row.source === "canvas" ? courseOf(row.detail) : null,
      }),
      kind: "record",
      title: row.title,
      source: {
        type: row.source,
        accountId: row.account_id,
        accountLabel: row.label,
        itemId: row.item_id,
        at: row.at,
        url: row.url,
      },
      status: "current",
      createdAt: iso(row.at ?? row.updated_at, nowIso),
      updatedAt: iso(row.updated_at, nowIso),
      text: [
        row.detail ?? "",
        "",
        "출처",
        `- 계정: ${row.label} (${row.account_id})`,
        `- 항목: ${row.item_id}`,
        ...(row.at === null ? [] : [`- 시각: ${row.at}`]),
        ...(row.url === null ? [] : [`- URL: ${row.url}`]),
      ].join("\n"),
    });
  });
}

type MemoryRow = {
  id: string;
  kind: string;
  text: string;
  source_json: string;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
};

/** Superseded memories stay as history with their correction provenance. */
export function memoryDrafts(db: Database, nowIso: string): WhiteboardDraft[] {
  return db
    .query<MemoryRow, []>(
      `SELECT id,kind,text,source_json,superseded_by,created_at,updated_at
         FROM memories ORDER BY created_at DESC, id`,
    )
    .all()
    .map((row) =>
      draft({
        originKey: `memory:${row.id}`,
        directory: "notes",
        leaf: datedPath({
          group: "notes",
          title: row.text,
          at: row.created_at,
          id: documentIdForOrigin(`memory:${row.id}`),
        }),
        kind: "thread",
        title: `메모리 · ${row.kind}`,
        source: {
          type: "memory",
          memoryId: row.id,
          memoryKind: row.kind,
          supersededBy: row.superseded_by,
          original: parseJson(row.source_json),
        },
        status: row.superseded_by === null ? "live" : "superseded",
        createdAt: iso(row.created_at, nowIso),
        updatedAt: iso(row.updated_at, nowIso),
        text: [
          row.text,
          "",
          ...(row.superseded_by === null ? [] : [`- 대체됨: ${row.superseded_by}`]),
          `- 메모리 id: ${row.id}`,
        ].join("\n"),
      }),
    );
}

type FileRow = {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  sha256: string;
  path: string;
  origin: string;
  created_at: string;
};

/** Uploaded-file metadata and its original location, never the bytes themselves. */
export function fileDrafts(db: Database, nowIso: string): WhiteboardDraft[] {
  return db
    .query<FileRow, []>(
      "SELECT id,name,mime,bytes,sha256,path,origin,created_at FROM files ORDER BY created_at DESC, id",
    )
    .all()
    .map((row) =>
      draft({
        originKey: `file:${row.id}`,
        directory: "resources",
        leaf: `resources/${documentIdForOrigin(`file:${row.id}`)}.md`,
        kind: "record",
        title: row.name,
        source: {
          type: "file",
          fileId: row.id,
          name: row.name,
          mime: row.mime,
          bytes: row.bytes,
          sha256: row.sha256,
          path: row.path,
          origin: row.origin,
        },
        status: "stored",
        createdAt: iso(row.created_at, nowIso),
        updatedAt: iso(row.created_at, nowIso),
        text: [
          `- 이름: ${row.name}`,
          `- MIME: ${row.mime}`,
          `- 크기: ${row.bytes} bytes`,
          `- sha256: ${row.sha256}`,
          `- 원본 경로: ${row.path}`,
          `- 출처: ${row.origin}`,
        ].join("\n"),
      }),
    );
}
