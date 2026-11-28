import { clipUtf8, documentIdForOrigin, isRecord, type WhiteboardDraft } from "./document";
import type { WhiteboardKind, WhiteboardSource } from "./types";

const MAX_PROJECTED_BODY = 180_000;

const KST = "Asia/Seoul";

/** A Korean slug: letters and digits kept, everything else collapsed to one dash. */
export function slugify(value: string, fallback: string): string {
  const slug = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug.length > 0 ? slug : fallback;
}

/**
 * The navigable part of a projected path, built the same way for every source so the tree
 * reads in the owner's timezone and a leaf is identifiable without opening it:
 * `<group>/<yyyy>/<mm>/<dd>-<slug>-<id6>.md`, or the same date under a course instead of a
 * month. Stable ids are untouched; only where the file sits changes with its content.
 */
export function datedPath(input: {
  readonly group: string;
  readonly title: string;
  readonly at: string | null;
  readonly id: string;
  readonly course?: string | null;
}): string {
  const date = new Date(input.at ?? Date.now());
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: KST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(Number.isNaN(date.getTime()) ? new Date() : date);
  const field = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  const yyyy = field("year");
  const mm = field("month");
  const dd = field("day");
  const leaf = `${yyyy}-${mm}-${dd}-${slugify(input.title, "item")}-${input.id.slice(-6)}.md`;
  const folder =
    input.course !== undefined && input.course !== null && input.course.trim().length > 0
      ? `${slugify(input.course, "course")}/${yyyy}`
      : `${yyyy}/${mm}`;
  return `${input.group}/${folder}/${leaf}`;
}

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
  /** A navigable leaf; when absent the deterministic id names the file. */
  readonly leaf?: string;
}): WhiteboardDraft {
  const id = documentIdForOrigin(input.originKey);
  return {
    id,
    path: input.leaf ?? `${input.directory}/${id}.md`,
    kind: input.kind,
    title: clean(input.title, id),
    source: input.source,
    status: input.status,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    text: clipUtf8(input.text, MAX_PROJECTED_BODY),
  };
}
