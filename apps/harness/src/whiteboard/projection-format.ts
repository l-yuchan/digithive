import { clipUtf8, documentIdForOrigin, isRecord, type WhiteboardDraft } from "./document";
import type { WhiteboardKind, WhiteboardSource } from "./types";

const MAX_PROJECTED_BODY = 180_000;

export function clean(value: string | null | undefined, fallback: string): string {
  const text = (value ?? "").replace(/[\r\n]+/g, " ").trim();
  const chosen = text.length > 0 ? text : fallback;
  return chosen.length > 200 ? `${chosen.slice(0, 197)}...` : chosen;
}

export function iso(value: string | null | undefined, fallback: string): string {
  return value !== null && value !== undefined && value.length > 0 ? value : fallback;
}

export function parseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function stringField(value: unknown, key: string): string {
  if (!isRecord(value)) return "";
  const field = value[key];
  return typeof field === "string" ? field : "";
}

export function draft(input: {
  readonly originKey: string;
  readonly directory: string;
  readonly kind: WhiteboardKind;
  readonly title: string;
  readonly source: WhiteboardSource;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly text: string;
}): WhiteboardDraft {
  const id = documentIdForOrigin(input.originKey);
  return {
    id,
    path: `${input.directory}/${id}.md`,
    kind: input.kind,
    title: clean(input.title, id),
    source: input.source,
    status: input.status,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    text: clipUtf8(input.text, MAX_PROJECTED_BODY),
  };
}
