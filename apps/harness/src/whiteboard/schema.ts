import { z } from "zod";
import { KIND_ROOTS, WHITEBOARD_KINDS, WhiteboardPathError } from "./types";

/** Bytes a single document may occupy. Kept here so writer and schema agree. */
export const MAX_DOCUMENT_BYTES = 200 * 1024;

const instant = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "invalid_instant");

const idShape = z.string().regex(/^wb_[A-Za-z0-9]{6,64}$/, "invalid_document_id");

const titleShape = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !value.includes("\n") && !value.includes("\r"), "invalid_title");

const statusShape = z.string().trim().min(1).max(64);

/** The JSON block between the `---` fence, valid YAML as well as JSON. */
export const WhiteboardFrontmatterSchema = z.object({
  id: idShape,
  kind: z.enum(WHITEBOARD_KINDS),
  title: titleShape,
  source: z.record(z.string(), z.unknown()),
  status: statusShape,
  createdAt: instant,
  updatedAt: instant,
});

export type WhiteboardFrontmatter = z.infer<typeof WhiteboardFrontmatterSchema>;

export const WhiteboardWriteSchema = z.object({
  path: z.string().min(1).max(512),
  kind: z.enum(WHITEBOARD_KINDS),
  title: titleShape,
  text: z.string(),
  source: z.record(z.string(), z.unknown()),
  status: statusShape.optional(),
  now: z.number().optional(),
});

export const WhiteboardUpdateSchema = z.object({
  id: z.string().min(1),
  expectedHash: z.string().regex(/^[a-f0-9]{64}$/, "invalid_hash"),
  text: z.string().optional(),
  status: statusShape.optional(),
  now: z.number().optional(),
});

export const WhiteboardListSchema = z.object({
  query: z.string().optional(),
  kind: z.enum(WHITEBOARD_KINDS).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

const SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Normalizes a caller path to `/`-separated ASCII segments relative to the kind's
 * root. Backslashes, NUL, empty segments, `.`, `..`, absolute paths and a wrong
 * kind root are refused rather than repaired, so a traversal cannot become a write.
 */
export function normalizeDocumentPath(
  raw: string,
  kind: (typeof WHITEBOARD_KINDS)[number],
): string {
  if (raw.length === 0 || raw.includes("\\") || raw.includes("\0") || raw.startsWith("/")) {
    throw new WhiteboardPathError();
  }
  const withSuffix = raw.endsWith(".md") ? raw : `${raw}.md`;
  const segments = withSuffix.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === ".." || !SEGMENT.test(segment)) {
      throw new WhiteboardPathError();
    }
  }
  if (segments[0] !== KIND_ROOTS[kind]) throw new WhiteboardPathError("kind_root_mismatch");
  return segments.join("/");
}

/** Whether a path already carries a safe shape under one of the known roots. */
export function isKnownRootPath(path: string): boolean {
  const root = path.split("/")[0];
  return Object.values(KIND_ROOTS).includes(root ?? "");
}
