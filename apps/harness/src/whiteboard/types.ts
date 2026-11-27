/**
 * The canonical whiteboard document model.
 *
 * Documents are Markdown files on disk; SQLite only holds a rebuildable index.
 * Every operational record projected here keeps its origin table authoritative.
 */

export const WHITEBOARD_KINDS = ["record", "thread", "commitment", "watch"] as const;
export type WhiteboardKind = (typeof WHITEBOARD_KINDS)[number];

/** A document may only live under the top-level directory of its kind. */
export const KIND_ROOTS: Readonly<Record<WhiteboardKind, string>> = {
  record: "records",
  thread: "threads",
  commitment: "commitments",
  watch: "watches",
};

/** Source provenance as stored in frontmatter; shape differs per origin. */
export type WhiteboardSource = Readonly<Record<string, unknown>>;

export type WhiteboardSummary = {
  readonly id: string;
  readonly path: string;
  readonly kind: WhiteboardKind;
  readonly title: string;
  readonly source: WhiteboardSource;
  readonly status: string;
  /** sha256 of the exact file bytes, used as the optimistic update guard. */
  readonly hash: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type WhiteboardDocument = WhiteboardSummary & {
  readonly text: string;
};

export type WhiteboardListInput = {
  readonly query?: string;
  readonly kind?: WhiteboardKind;
  readonly limit?: number;
};

export type WhiteboardWriteInput = {
  readonly path: string;
  readonly kind: WhiteboardKind;
  readonly title: string;
  readonly text: string;
  readonly source: WhiteboardSource;
  readonly status?: string;
  readonly now?: number;
};

export type WhiteboardUpdateInput = {
  readonly id: string;
  readonly expectedHash: string;
  readonly text?: string;
  readonly status?: string;
  readonly now?: number;
};

export type WhiteboardStore = {
  /** Reconcile disk into the index, then materialize every operational source. */
  refresh(): void;
  list(input?: WhiteboardListInput): WhiteboardSummary[];
  read(id: string): WhiteboardDocument | null;
  write(input: WhiteboardWriteInput): WhiteboardDocument;
  update(input: WhiteboardUpdateInput): WhiteboardDocument;
};

/** A refusal with a stable code a route or tool can map to a status. */
export class WhiteboardError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = "WhiteboardError";
    this.code = code;
  }
}

/** A path that would escape its kind root or is not a safe relative ASCII path. */
export class WhiteboardPathError extends WhiteboardError {
  constructor(code = "invalid_path") {
    super(code, code);
    this.name = "WhiteboardPathError";
  }
}

export class WhiteboardNotFoundError extends WhiteboardError {
  constructor(id: string) {
    super("document_not_found", `document_not_found: ${id}`);
    this.name = "WhiteboardNotFoundError";
  }
}

/**
 * The on-disk revision moved past the hash the caller read. The exact pair is
 * attached so a client can re-read and retry instead of overwriting blindly.
 */
export class WhiteboardConflictError extends WhiteboardError {
  readonly expectedHash: string;
  readonly actualHash: string;

  constructor(expectedHash: string, actualHash: string) {
    super("stale_hash", `stale_hash: expected ${expectedHash}, actual ${actualHash}`);
    this.name = "WhiteboardConflictError";
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
  }
}
