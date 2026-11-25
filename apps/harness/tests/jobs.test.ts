import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/store/db";
import { RESET_VERSION } from "../src/store/migrations";
import { EventLog } from "../src/events/log";
import { installJobs, JOB_FILES, JOB_SOURCE_ROOT } from "../src/jobs/install";
import { jobTools, listJobAccounts } from "../src/tools/jobs";
import { allowedTools } from "../src/sdk/capabilities";
import { collectionExecutor } from "../src/workflows/collection";
import { searchWorkflowIds } from "../src/workflows/workflow-search";

const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function fresh(): Database {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  migrate(db);
  return db;
}

/**
 * A database as the build that shipped v10 left it: builtin executors and a recorded
 * version one below the kept v11 transition, which is the state the upgrade repairs.
 * `entries` is the executor per workflow; the rows are written before the version
 * moves, exactly like the old build stored them.
 */
function atV10(entries: readonly [string, string, unknown][]): Database {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  migrate(db);
  db.transaction(() => {
    db.exec("PRAGMA foreign_keys=OFF");
    db.query("DELETE FROM schedules").run();
    db.query("DELETE FROM workflows_fts").run();
    db.query("DELETE FROM workflows").run();
    for (const [id, title, executor] of entries) {
      db.query(
        "INSERT INTO workflows(id,title,instruction,executor_json,params_json,timeout_seconds,created_at,updated_at) VALUES (?,?,?,?, '[]', 60, 'now', 'now')",
      ).run(id, title, `${title} 지시`, JSON.stringify(executor));
    }
    db.exec(`PRAGMA user_version = ${RESET_VERSION - 1}`);
  })();
  return db;
}

function executorOf(db: Database, id: string): unknown {
  const row = db
    .query<{ executor_json: string }, [string]>("SELECT executor_json FROM workflows WHERE id = ?")
    .get(id);
  return row === null ? null : JSON.parse(row.executor_json);
}

describe("v11 turns stored builtin executors into script jobs", () => {
  test("a collection builtin keeps its account as the script argument and drops its source list", () => {
    const db = atV10([
      [
        "wf-collect",
        "연결 자료 수집 · A",
        { kind: "builtin", name: "sync_sources", accountId: "acct-a", sources: ["gmail"] },
      ],
    ]);
    expect(migrate(db)).toBe(2);
    // No stored source list: a source switched off after this save must stop the
    // next run, which only holds when the run asks the account at that moment.
    expect(executorOf(db, "wf-collect")).toEqual({
      kind: "script",
      path: "jobs/collection.ts",
      args: ["acct-a"],
      capabilities: ["account.read"],
    });
  });

  test("a briefing builtin becomes the shipped briefing job with its two capabilities", () => {
    const db = atV10([["wf-brief", "아침 브리핑", { kind: "builtin", name: "briefing" }]]);
    migrate(db);
    expect(executorOf(db, "wf-brief")).toEqual({
      kind: "script",
      path: "jobs/briefing.ts",
      args: [],
      capabilities: ["account.read", "mail.send"],
    });
  });

  test("a seeded definition naming a job file that was never installed is repaired", () => {
    // The seed published this path before the file existed, so it could not run.
    const db = atV10([
      [
        "wf-system-briefing-morning",
        "아침 브리핑",
        { kind: "script", path: "jobs/briefing.ts", args: [] },
      ],
    ]);
    migrate(db);
    expect(executorOf(db, "wf-system-briefing-morning")).toEqual({
      kind: "script",
      path: "jobs/briefing.ts",
      args: [],
      capabilities: ["account.read", "mail.send"],
    });
  });

  test("the owner's own missing script is left alone", () => {
    const db = atV10([
      ["wf-mine", "내 작업", { kind: "script", path: "mine/report.ts", args: [] }],
    ]);
    migrate(db);
    expect(executorOf(db, "wf-mine")).toMatchObject({ path: "mine/report.ts" });
  });

  test("running the chain again rewrites nothing", () => {
    const db = atV10([
      ["wf-collect", "수집", { kind: "builtin", name: "sync_sources", accountId: "acct-a" }],
    ]);
    expect(migrate(db)).toBe(2);
    expect(migrate(db)).toBe(0);
  });
});

describe("the app's jobs are ordinary scripts", () => {
  test("every job file is planted verbatim under the scripts root", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-jobs-"));
    try {
      expect(installJobs(root)).toHaveLength(JOB_FILES.length);
      for (const file of JOB_FILES) {
        const shipped = readFileSync(join(JOB_SOURCE_ROOT, file), "utf8");
        expect(readFileSync(join(root, "jobs", file), "utf8")).toBe(shipped);
      }
      // A second start changes nothing.
      expect(installJobs(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a rewritten definition stays findable by its title", () => {
    const db = atV10([
      [
        "wf-collect",
        "연결 자료 수집 · A",
        { kind: "builtin", name: "sync_sources", accountId: "acct-a" },
      ],
    ]);
    migrate(db);
    expect(searchWorkflowIds(db, { keyword: "연결 자료" }).map((hit) => hit.id)).toContain(
      "wf-collect",
    );
  });

  test("a collection workflow names the job path and its account argument", () => {
    expect(collectionExecutor("acct-a")).toEqual({
      kind: "script",
      path: "jobs/collection.ts",
      args: ["acct-a"],
      capabilities: ["account.read"],
    });
  });

  test("a job sees only the sources the owner left on", () => {
    const db = fresh();
    db.query(
      "INSERT INTO integration_accounts(id,provider,subject,email,label,created_at,updated_at) VALUES ('acct-a','google','s','a@example.com','A','2026-01-01','2026-01-01')",
    ).run();
    db.query(
      "INSERT INTO account_sources(account_id,source,enabled) VALUES ('acct-a','gmail',1),('acct-a','calendar',0)",
    ).run();
    const [account] = listJobAccounts(db, "acct-a");
    expect(account?.sources).toEqual(["gmail"]);
    // Nothing is connected yet, and the job must be able to say so.
    expect(account?.connected).toBe(false);
  });
});

describe("job capabilities gate the job tools", () => {
  test("account.read and mail.send are the only way to reach the job's own tools", () => {
    expect([...allowedTools(["account.read"])].toSorted()).toEqual([
      "account_list",
      "source_collect",
    ]);
    expect([...allowedTools(["mail.send"])].toSorted()).toEqual(["briefing_compose", "push_send"]);
    expect([...allowedTools([])]).toEqual([]);
  });

  test("an unconfigured push reports no device instead of failing", async () => {
    const db = fresh();
    // The events and sync clients are never touched by a push without VAPID keys.
    const deps = {
      db,
      events: new EventLog(db),
      google: {
        db,
        events: new EventLog(db),
        config: { clientId: "", clientSecret: "", redirectUri: "" },
        vaultSecret: "",
      },
      canvas: { db, events: new EventLog(db), config: { baseUrl: "", token: "" } },
    };
    const unconfigured = jobTools(deps).find((tool) => tool.name === "push_send");
    if (!unconfigured) throw new Error("push_send tool missing");
    const raw: unknown = JSON.parse(
      await unconfigured.execute({ title: "t", body: "b" }, { runId: "r" }),
    );
    expect(raw).toEqual({ sent: 0, failed: 0, errors: ["push_unconfigured"] });
  });
});
