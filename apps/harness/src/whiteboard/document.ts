import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { MAX_DOCUMENT_BYTES, WhiteboardFrontmatterSchema } from "./schema";
import type { WhiteboardDocument, WhiteboardKind, WhiteboardSource } from "./types";

/** A document before its bytes (and therefore its hash) exist, as projections build it. */
export type WhiteboardDraft = Omit<WhiteboardDocument, "hash">;

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** JSON with object keys sorted so the same facts always hash the same. */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, sortValue(value[key])]),
    );
  }
  return value;
}

/** A manual path owns an id derived from the path it was created at. */
export function documentIdForPath(path: string): string {
  return `wb_${sha256Hex(`path:${path}`).slice(0, 24)}`;
}

/** An operational projection owns an id derived from its stable origin key. */
export function documentIdForOrigin(originKey: string): string {
  return `wb_${sha256Hex(`origin:${originKey}`).slice(0, 24)}`;
}

export type EncodeInput = {
  readonly id: string;
  readonly kind: WhiteboardKind;
  readonly title: string;
  readonly source: WhiteboardSource;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly text: string;
};

/** A deterministic file: JSON frontmatter (valid YAML), H1, body. */
export function encodeDocument(document: EncodeInput): string {
  const frontmatter = stableJson({
    id: document.id,
    kind: document.kind,
    title: document.title,
    source: document.source,
    status: document.status,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  });
  return `---\n${frontmatter}\n---\n# ${document.title}\n\n${document.text}\n`;
}

/** Parses untrusted file bytes; a malformed file is skipped, never indexed. */
export function parseDocument(raw: string): WhiteboardDocument | null {
  const normalized = raw.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(normalized);
  if (!match) return null;
  let frontmatter: unknown;
  try {
    frontmatter = JSON.parse(match[1] ?? "");
  } catch {
    return null;
  }
  const parsed = WhiteboardFrontmatterSchema.safeParse(frontmatter);
  if (!parsed.success) return null;
  const value = parsed.data;
  let body = match[2] ?? "";
  const heading = `# ${value.title}\n\n`;
  if (body.startsWith(heading)) body = body.slice(heading.length);
  if (body.endsWith("\n")) body = body.slice(0, -1);
  return {
    id: value.id,
    path: "",
    kind: value.kind,
    title: value.title,
    source: value.source,
    status: value.status,
    hash: sha256Hex(raw),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    text: body,
  };
}

export function documentBytes(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

export function assertDocumentSize(content: string): void {
  if (documentBytes(content) > MAX_DOCUMENT_BYTES) throw new Error("document_too_large");
}

/** Clips text on a UTF-8 boundary so a projection never exceeds the cap. */
export function clipUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

function safeAbsolute(root: string, relative: string): string {
  const absolute = resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) throw new Error("path_escape");
  return absolute;
}

export function readDocumentFile(
  root: string,
  relative: string,
): { readonly raw: string; readonly document: WhiteboardDocument } | null {
  const absolute = safeAbsolute(root, relative);
  if (!existsSync(absolute)) return null;
  const raw = readFileSync(absolute, "utf8");
  const parsed = parseDocument(raw);
  return parsed ? { raw, document: { ...parsed, path: relative } } : null;
}

/** Same-directory unique temp file, then one atomic rename. */
export function writeDocumentFile(root: string, relative: string, content: string): void {
  assertDocumentSize(content);
  const absolute = safeAbsolute(root, relative);
  mkdirSync(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporary, content, "utf8");
    renameSync(temporary, absolute);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

export function removeDocumentFile(root: string, relative: string): void {
  rmSync(safeAbsolute(root, relative), { force: true });
}

/** Every `.md` beneath the root, as normalized relative paths. */
export function listMarkdownFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile() && entry.name.endsWith(".md") && statSync(absolute).isFile())
        found.push(relative);
    }
  };
  visit(root, "");
  return found.toSorted();
}
