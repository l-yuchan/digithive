import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertDocumentSize,
  documentIdForPath,
  encodeDocument,
  readDocumentFile,
  sha256Hex,
  stableJson,
  writeDocumentFile,
} from "./document";
import { indexWhiteboard, pathForDocument, queryIndex } from "./sqlite-index";
import { projectOperationalDocuments } from "./projector";
import { WhiteboardUpdateSchema, WhiteboardWriteSchema, normalizeDocumentPath } from "./schema";
import {
  WhiteboardConflictError,
  WhiteboardError,
  WhiteboardNotFoundError,
  type WhiteboardDocument,
  type WhiteboardKind,
  type WhiteboardListInput,
  type WhiteboardSource,
  type WhiteboardStore,
  type WhiteboardSummary,
  type WhiteboardUpdateInput,
  type WhiteboardWriteInput,
} from "./types";

export { WHITEBOARD_SCHEMA_SQL } from "./sqlite-index";

function defaultStatus(kind: WhiteboardKind): string {
  if (kind === "commitment") return "open";
  if (kind === "watch") return "enabled";
  if (kind === "record") return "current";
  return "active";
}

function iso(now: number): string {
  return new Date(now).toISOString();
}

function sameContent(
  document: WhiteboardDocument,
  input: {
    readonly kind: WhiteboardKind;
    readonly title: string;
    readonly source: WhiteboardSource;
    readonly status: string;
    readonly text: string;
  },
): boolean {
  return (
    document.kind === input.kind &&
    document.title === input.title &&
    document.status === input.status &&
    document.text === input.text &&
    stableJson(document.source) === stableJson(input.source)
  );
}

export type WhiteboardStoreWithRoot = WhiteboardStore & {
  /** The absolute directory the documents live in, for tools and QA that need it. */
  readonly root: string;
};

export function createWhiteboardStore(db: Database, root: string): WhiteboardStoreWithRoot {
  const absoluteRoot = resolve(root);
  mkdirSync(absoluteRoot, { recursive: true });

  function refresh(): void {
    indexWhiteboard(db, absoluteRoot);
    projectOperationalDocuments(db, absoluteRoot, Date.now());
    indexWhiteboard(db, absoluteRoot);
  }

  function list(input: WhiteboardListInput = {}): WhiteboardSummary[] {
    refresh();
    return queryIndex(db, input);
  }

  function read(id: string): WhiteboardDocument | null {
    refresh();
    const path = pathForDocument(db, id);
    return path === null ? null : (readDocumentFile(absoluteRoot, path)?.document ?? null);
  }

  function write(input: WhiteboardWriteInput): WhiteboardDocument {
    const parsed = WhiteboardWriteSchema.parse(input);
    const path = normalizeDocumentPath(parsed.path, parsed.kind);
    const status = parsed.status ?? defaultStatus(parsed.kind);
    const existing = readDocumentFile(absoluteRoot, path);
    if (existing !== null) {
      if (
        sameContent(existing.document, {
          kind: parsed.kind,
          title: parsed.title,
          source: parsed.source,
          status,
          text: parsed.text,
        })
      )
        return existing.document;
      throw new WhiteboardError("path_exists", `path_exists: ${path}`);
    }
    const now = parsed.now ?? Date.now();
    const document: WhiteboardDocument = {
      id: documentIdForPath(path),
      path,
      kind: parsed.kind,
      title: parsed.title,
      source: parsed.source,
      status,
      hash: "",
      createdAt: iso(now),
      updatedAt: iso(now),
      text: parsed.text,
    };
    const content = encodeDocument(document);
    assertDocumentSize(content);
    writeDocumentFile(absoluteRoot, path, content);
    indexWhiteboard(db, absoluteRoot);
    return { ...document, hash: sha256Hex(content) };
  }

  function update(input: WhiteboardUpdateInput): WhiteboardDocument {
    const parsed = WhiteboardUpdateSchema.parse(input);
    if (parsed.text === undefined && parsed.status === undefined)
      throw new WhiteboardError("empty_update");
    let path = pathForDocument(db, parsed.id);
    if (path === null) {
      indexWhiteboard(db, absoluteRoot);
      path = pathForDocument(db, parsed.id);
    }
    if (path === null) throw new WhiteboardNotFoundError(parsed.id);
    const existing = readDocumentFile(absoluteRoot, path);
    if (existing === null) throw new WhiteboardNotFoundError(parsed.id);
    if (existing.document.hash !== parsed.expectedHash) {
      throw new WhiteboardConflictError(parsed.expectedHash, existing.document.hash);
    }
    const document: WhiteboardDocument = {
      ...existing.document,
      status: parsed.status ?? existing.document.status,
      text: parsed.text ?? existing.document.text,
      updatedAt: iso(parsed.now ?? Date.now()),
      hash: "",
    };
    const content = encodeDocument(document);
    assertDocumentSize(content);
    writeDocumentFile(absoluteRoot, path, content);
    indexWhiteboard(db, absoluteRoot);
    return { ...document, hash: sha256Hex(content) };
  }

  return { root: absoluteRoot, refresh, list, read, write, update };
}
