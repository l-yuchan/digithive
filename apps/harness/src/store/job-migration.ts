import type { Database, SQLQueryBindings } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BRIEFING_SCRIPT, COLLECTION_SCRIPT } from "../workflows/workflow-store";
/**
 * v11 turns the two former builtin executors into the app's own script jobs.
 *
 * A job is not a kind. It is a script whose path points at `jobs/`, so a stored
 * builtin becomes `{kind:"script", path:"jobs/…"}` with its account kept as the
 * script argument. The stored source list is dropped on purpose: the collection
 * script reads the account's switches at each run, which is the only arrangement in
 * which a feature turned off after the workflow was saved actually stops collection.
 *
 * It also repairs definitions that named a shipped job under a path that was never
 * installed (the briefing seeds did), since such a workflow could not run at all.
 * A definition whose own file is missing is the owner's and is left alone.
 */

type Row = {
  readonly id: string;
  readonly title: string;
  readonly instruction: string;
  readonly executorJson: string;
};

function executorOf(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json || "{}");
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(Object.entries(parsed));
  } catch {
    return {};
  }
}

function collection(accountId: unknown): Record<string, unknown> {
  return {
    kind: "script",
    path: COLLECTION_SCRIPT,
    args: typeof accountId === "string" && accountId.length > 0 ? [accountId] : [],
    capabilities: ["account.read"],
  };
}

function briefing(): Record<string, unknown> {
  return {
    kind: "script",
    path: BRIEFING_SCRIPT,
    args: [],
    capabilities: ["account.read", "mail.send"],
  };
}

/** Which shipped job a path names, if any. */
function shippedJob(path: unknown): "collection" | "briefing" | null {
  if (typeof path !== "string") return null;
  if (path.endsWith("/collection.ts") || path === "collection.ts") return "collection";
  if (path.endsWith("/briefing.ts") || path === "briefing.ts") return "briefing";
  return null;
}

export function migrateBuiltinExecutors(
  db: Database,
  options: { readonly scriptsRoot?: string; readonly now?: number } = {},
): { rewritten: number; repaired: number } {
  const iso = new Date(options.now ?? Date.now()).toISOString();
  const rows = db
    .query<Row, SQLQueryBindings[]>(
      "SELECT id,title,instruction,executor_json AS executorJson FROM workflows",
    )
    .all();
  const root = options.scriptsRoot ?? process.env["HARNESS_SCRIPTS_ROOT"] ?? "";
  const installed = (path: string) => root.length > 0 && existsSync(join(root, path));

  let rewritten = 0;
  let repaired = 0;
  db.transaction(() => {
    for (const row of rows) {
      const executor = executorOf(row.executorJson);
      let next: Record<string, unknown> | null = null;
      if (executor["kind"] === "builtin") {
        next = executor["name"] === "briefing" ? briefing() : collection(executor["accountId"]);
        rewritten += 1;
      } else if (executor["kind"] === "script") {
        const job = shippedJob(executor["path"]);
        if (job !== null && !installed(String(executor["path"]))) {
          next =
            job === "briefing"
              ? briefing()
              : Array.isArray(executor["args"])
                ? { ...collection(executor["args"][0]), args: executor["args"] }
                : collection(null);
          repaired += 1;
        }
      }
      if (next === null) continue;
      db.query("UPDATE workflows SET executor_json=?, updated_at=? WHERE id=?").run(
        JSON.stringify(next),
        iso,
        row.id,
      );
      db.query("DELETE FROM workflows_fts WHERE workflow_id = ?").run(row.id);
      db.query("INSERT INTO workflows_fts (workflow_id, text) VALUES (?, ?)").run(
        row.id,
        `${row.title} ${row.instruction}`,
      );
    }
  })();
  return { rewritten, repaired };
}
