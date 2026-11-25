import type { Database } from "bun:sqlite";

/**
 * How a database reaches the current schema.
 *
 * RULE (owner, 2026-11-25): this project is not production. Every legacy database is
 * brought to the latest schema, and only the TWO most recent transitions are kept.
 * When the schema changes, the oldest transition is dropped and a new one appended,
 * so the chain is always exactly two steps: at v100 it holds v98→v99 and v99→v100.
 *
 * The eleven first steps (v1..v10) produced the RESET below and are gone; a fresh
 * database starts there, and the live server was already at v10 when this file was
 * written. What was lost is the ability to open anything older, which the rule
 * accepts: those versions never left this machine.
 *
 * - A shipped transition is never edited; add the next one instead.
 * - `run` exists for a rewrite SQL cannot express. It executes inside the
 *   transition's transaction, so the version bump and the rewrite are one step.
 */

export type Transition = {
  /** The version a database holds once this transition has run. */
  readonly version: number;
  readonly sql: string;
  /** A row-by-row rewrite, applied inside the same transaction as `sql`. */
  readonly run?: (db: Database) => void;
};

/** The version a brand-new database starts at. */
export const RESET_VERSION = 11;

const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/**
 * RESET — the schema at v11 as one statement set.
 *
 * It is the product of the retired v1..v10 steps: the columns, checks, indexes and
 * triggers are the ones SQLite reported on the live server at v10, so a column a
 * later `ALTER TABLE` dropped no longer appears. The seeded rows are born in their
 * final shape too: the `google-default` placeholder and its renaming were steps,
 * not a schema.
 */
export const RESET_SCHEMA = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  deleted_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  leaf_id TEXT
);

CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  parent_id TEXT REFERENCES entries(id),
  kind TEXT NOT NULL,
  role TEXT,
  status TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  seq INTEGER NOT NULL
);
CREATE INDEX entries_tree ON entries(session_id, parent_id);
CREATE UNIQUE INDEX entries_seq ON entries(session_id, seq);

CREATE VIRTUAL TABLE entries_fts USING fts5(
  entry_id UNINDEXED,
  session_id UNINDEXED,
  text,
  tokenize = 'trigram'
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id),
  parent_run_id TEXT REFERENCES runs(id),
  origin TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL,
  cancel_intent TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  budget_json TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL,
  settled_at TEXT,
  state_json TEXT,
  executor_json TEXT NOT NULL DEFAULT '{"kind":"agent"}',
  timeout_seconds INTEGER NOT NULL DEFAULT 1800 CHECK(timeout_seconds BETWEEN 1 AND 86400),
  workflow_id TEXT,
  workflow_title TEXT,
  schedule_id TEXT,
  trigger_kind TEXT CHECK(trigger_kind IN ('schedule','manual','tool','script','delegation')),
  params_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX runs_live ON runs(status, lease_expires_at);
CREATE INDEX runs_origin ON runs(origin, status);
CREATE INDEX runs_workflow ON runs(workflow_id, created_at);

CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  entry_id TEXT REFERENCES entries(id),
  name TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  decision TEXT,
  decision_by TEXT,
  status TEXT NOT NULL,
  result_json TEXT,
  started_at TEXT,
  ended_at TEXT,
  deadline_at TEXT
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  tool_call_id TEXT NOT NULL REFERENCES tool_calls(id),
  status TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  note TEXT
);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  session_id TEXT,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX events_run ON events(run_id, seq);
CREATE INDEX events_session ON events(session_id, seq);

CREATE TABLE saved_approvals (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  source_json TEXT NOT NULL DEFAULT '{}',
  superseded_by TEXT REFERENCES memories(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX memories_live ON memories(superseded_by);

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  path TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'upload',
  created_at TEXT NOT NULL
);
CREATE INDEX files_sha ON files(sha256);

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_success_at TEXT,
  last_error TEXT,
  last_error_at TEXT
);

CREATE TABLE briefings (
  id TEXT PRIMARY KEY,
  slot TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  run_id TEXT REFERENCES runs(id)
);
CREATE UNIQUE INDEX briefings_run ON briefings(run_id) WHERE run_id IS NOT NULL;
CREATE UNIQUE INDEX briefings_slot_day ON briefings(slot,substr(created_at,1,10)) WHERE run_id IS NULL;

CREATE TABLE integration_accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('google','canvas')),
  subject TEXT,
  email TEXT,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider,subject)
);

CREATE TABLE account_sources (
  account_id TEXT NOT NULL REFERENCES integration_accounts(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK(source IN ('calendar','gmail','canvas')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  cursor TEXT,
  last_sync_at TEXT,
  last_attempt_at TEXT,
  ok INTEGER NOT NULL DEFAULT 0 CHECK(ok IN (0,1)),
  error TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(account_id,source)
);

CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  account_id TEXT REFERENCES integration_accounts(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE oauth_tokens (
  account_id TEXT PRIMARY KEY REFERENCES integration_accounts(id) ON DELETE CASCADE,
  payload TEXT NOT NULL,
  scope TEXT,
  expires_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE sync_items (
  account_id TEXT NOT NULL,
  source TEXT NOT NULL,
  item_id TEXT NOT NULL,
  title TEXT NOT NULL,
  at TEXT,
  detail TEXT,
  url TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(account_id,source,item_id),
  FOREIGN KEY(account_id,source) REFERENCES account_sources(account_id,source) ON DELETE CASCADE
);
CREATE INDEX sync_items_at ON sync_items(source,at);

CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  instruction TEXT NOT NULL,
  executor_json TEXT NOT NULL CHECK(json_valid(executor_json)),
  params_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(params_json)),
  timeout_seconds INTEGER NOT NULL DEFAULT 1800 CHECK(timeout_seconds BETWEEN 1 AND 86400),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX workflows_updated ON workflows(updated_at);
CREATE VIRTUAL TABLE workflows_fts USING fts5(workflow_id UNINDEXED, text, tokenize = 'trigram');

CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  trigger_json TEXT NOT NULL CHECK(json_valid(trigger_json)),
  next_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  workflow_id TEXT REFERENCES workflows(id) ON DELETE RESTRICT,
  args_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(args_json))
);
CREATE INDEX schedules_due ON schedules(enabled,next_run_at);
CREATE INDEX schedules_workflow ON schedules(workflow_id);
CREATE TRIGGER schedules_require_workflow_insert BEFORE INSERT ON schedules
WHEN NEW.workflow_id IS NULL BEGIN SELECT RAISE(ABORT,'schedule_workflow_required'); END;
CREATE TRIGGER schedules_require_workflow_update BEFORE UPDATE OF workflow_id ON schedules
WHEN NEW.workflow_id IS NULL BEGIN SELECT RAISE(ABORT,'schedule_workflow_required'); END;

CREATE TABLE schedule_occurrences (
  id TEXT PRIMARY KEY,
  schedule_id TEXT REFERENCES schedules(id) ON DELETE SET NULL,
  schedule_title TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
  manual INTEGER NOT NULL DEFAULT 0 CHECK(manual IN (0,1)),
  created_at TEXT NOT NULL,
  UNIQUE(schedule_id,scheduled_for)
);
CREATE INDEX schedule_occurrences_schedule ON schedule_occurrences(schedule_id,created_at);

INSERT INTO integration_accounts (id,provider,label,created_at,updated_at) VALUES
  ('6f1c7a52-9b3e-4f8a-9c2d-71b0a5d4e8c6','google','Google 계정',${now},${now}),
  ('canvas-default','canvas','한양 LMS',${now},${now});
INSERT INTO account_sources(account_id,source) VALUES
  ('6f1c7a52-9b3e-4f8a-9c2d-71b0a5d4e8c6','calendar'),
  ('6f1c7a52-9b3e-4f8a-9c2d-71b0a5d4e8c6','gmail'),
  ('canvas-default','canvas');
`;

/**
 * v11 — no schema change; the version that turned the two former builtin executors
 * into the app's own script jobs. It is kept in the chain (cap 2) so a database
 * written by the build that shipped it still opens: that build seeded
 * `{kind:"builtin"}` executors, and a definition naming a shipped job without its
 * capabilities could not run. A fresh database never passes through it, because the
 * reset already carries the final shape and later seeds are written as scripts.
 */
export const V11: Transition = {
  version: 11,
  sql: "SELECT 1;",
  run: (db) => {
    // What the v10 build itself wrote: a shipped job path, but without the capability
    // list v11 introduced. Both shapes it left behind are repaired.
    const staleShipped = `(
      SELECT json_extract(executor_json,'$.path') IN ('jobs/collection.ts','jobs/briefing.ts')
         AND json_extract(executor_json,'$.capabilities') IS NULL
    )`;
    const rows = db
      .query<{ id: string; title: string; instruction: string; executorJson: string }, []>(
        `SELECT id,title,instruction,executor_json AS executorJson FROM workflows
          WHERE json_extract(executor_json,'$.kind') = 'builtin' OR ${staleShipped}`,
      )
      .all();
    const updatedAt = new Date().toISOString();
    for (const row of rows) {
      const executor = objectOf(row.executorJson);
      const job = shippedJob(executor["path"]);
      let next: Record<string, unknown> | null = null;
      if (executor["kind"] === "builtin") {
        next =
          executor["name"] === "briefing"
            ? shippedExecutor("briefing")
            : shippedExecutor("collection", executor["accountId"]);
      } else if (job !== null) {
        const args = Array.isArray(executor["args"]) ? executor["args"] : [];
        next =
          job === "briefing" ? shippedExecutor("briefing") : shippedExecutor("collection", args[0]);
        if (job === "collection" && args.length > 1) next["args"] = args;
      }
      if (next === null) continue;
      db.query("UPDATE workflows SET executor_json=?, updated_at=? WHERE id=?").run(
        JSON.stringify(next),
        updatedAt,
        row.id,
      );
      reindexWorkflow(db, row.id, row.title, row.instruction);
    }
  },
};

/**
 * v12 — entry payloads hold events in the database, not only when read.
 *
 * Records written before v11 store `parts`; every reader converted them on the way
 * out. v12 writes them back in the one shape every writer produces, so the read path
 * loses its legacy branch. A denied tool result keeps `denied` instead of being
 * folded into `failed`. The reset no longer creates the v1 `parts` table: nothing has
 * written it since entries became the payload owner.
 */
export const V12: Transition = {
  version: 12,
  sql: "DROP TABLE IF EXISTS parts;",
  run: (db) => {
    const rows = db
      .query<{ id: string; session_id: string; payload_json: string }, []>(
        "SELECT id, session_id, payload_json FROM entries",
      )
      .all();
    for (const row of rows) {
      let payload: unknown;
      try {
        payload = JSON.parse(row.payload_json);
      } catch {
        continue;
      }
      if (typeof payload === "object" && payload !== null && "events" in payload) continue;
      const events = eventsFromStoredParts(payload);
      if (events === null) continue;
      db.query("UPDATE entries SET payload_json=? WHERE id=?").run(
        JSON.stringify({ events }),
        row.id,
      );
      // Re-indexed by the same rule the writer uses, so a converted entry is as
      // findable as one written today.
      db.query("DELETE FROM entries_fts WHERE entry_id = ?").run(row.id);
      const text = events
        .map((event) => (event.type === "text" ? event.text : ""))
        .filter((part) => part.length > 0)
        .join("\n")
        .trim();
      if (text.length >= 3)
        db.query("INSERT INTO entries_fts (entry_id, session_id, text) VALUES (?,?,?)").run(
          row.id,
          row.session_id,
          text,
        );
    }
  },
};

/** The newest version this build writes. */
export const LATEST = V12.version;

/** At most two steps, as the rule requires. */
export const TRANSITIONS: readonly Transition[] = [V11, V12];

/** The executor a shipped job carries: the path, the account, the grant. */
export function shippedExecutor(
  job: "collection",
  accountId?: unknown,
): {
  kind: "script";
  path: string;
  args: string[];
  capabilities: ["account.read"];
};
export function shippedExecutor(
  job: "briefing",
  accountId?: unknown,
): {
  kind: "script";
  path: string;
  args: string[];
  capabilities: ["account.read", "mail.send"];
};
export function shippedExecutor(
  job: "collection" | "briefing",
  accountId?: unknown,
): Record<string, unknown> {
  if (job === "briefing")
    return {
      kind: "script",
      path: "jobs/briefing.ts",
      args: [],
      capabilities: ["account.read", "mail.send"],
    };
  return {
    kind: "script",
    path: "jobs/collection.ts",
    args: typeof accountId === "string" && accountId.length > 0 ? [accountId] : [],
    capabilities: ["account.read"],
  };
}

function shippedJob(path: unknown): "collection" | "briefing" | null {
  if (typeof path !== "string") return null;
  if (path.endsWith("/collection.ts") || path === "collection.ts") return "collection";
  if (path.endsWith("/briefing.ts") || path === "briefing.ts") return "briefing";
  return null;
}

function objectOf(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json || "{}");
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(Object.entries(parsed));
  } catch {
    return {};
  }
}

function reindexWorkflow(db: Database, id: string, title: string, instruction: string): void {
  db.query("DELETE FROM workflows_fts WHERE workflow_id = ?").run(id);
  db.query("INSERT INTO workflows_fts (workflow_id, text) VALUES (?, ?)").run(
    id,
    `${title} ${instruction}`,
  );
}

type StoredEvent =
  | { type: "thinking" | "text"; id: number; text: string }
  | { type: "tool_call"; id: number; callId: string; name: string; detail: string }
  | {
      type: "tool_result";
      id: number;
      callId: string;
      name: string;
      detail: string;
      failed?: boolean;
      denied?: boolean;
    }
  | { type: "error"; id: number; detail: string };

type StoredPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | {
      type: "tool_result";
      id: string;
      name: string;
      output: string;
      denied?: boolean;
      timeout?: boolean;
    }
  | { type: "error"; message: string };

/** A pre-v11 payload reads as the events it described; anything else yields null. */
export function eventsFromStoredParts(payload: unknown): StoredEvent[] | null {
  if (typeof payload !== "object" || payload === null) return null;
  const parts = (payload as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return null;
  return parts.map((raw: StoredPart, index): StoredEvent => {
    switch (raw.type) {
      case "text":
        return { type: "text", id: index, text: raw.text };
      case "reasoning":
        return { type: "thinking", id: index, text: raw.text };
      case "tool_call":
        return {
          type: "tool_call",
          id: index,
          callId: raw.id,
          name: raw.name,
          detail: raw.arguments,
        };
      case "tool_result":
        return {
          type: "tool_result",
          id: index,
          callId: raw.id,
          name: raw.name,
          detail: raw.output,
          ...(raw.denied || raw.timeout ? { failed: true } : {}),
          ...(raw.denied ? { denied: true } : {}),
        };
      case "error":
        return { type: "error", id: index, detail: raw.message };
      default:
        // A stored row is unvalidated input; an unknown part is shown, not dropped.
        return {
          type: "error",
          id: index,
          detail: `unknown stored part ${String((raw as { type?: unknown }).type)}`,
        };
    }
  });
}
