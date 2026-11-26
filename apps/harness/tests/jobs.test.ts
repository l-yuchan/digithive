import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/store/db";
import { EventLog } from "../src/events/log";
import { installJobs, JOB_FILES, JOB_SOURCE_ROOT } from "../src/jobs/install";
import { jobTools, listJobAccounts } from "../src/tools/jobs";
import { resolveScriptPath } from "../src/surfaces/work/script";
import { allowedTools } from "../src/sdk/capabilities";
import { collectionExecutor } from "../src/workflows/collection";
import { searchWorkflowIds } from "../src/workflows/workflow-search";
import { SdkBridge } from "../src/sdk/bridge";
import { createRegistry } from "../src/tools/registry";
import {
  WORK_LIMITS,
  claimNext,
  enqueueRun,
  executeRun,
  getRun,
} from "../src/surfaces/work/runner";

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

/** An installed-then-edited definition: the search index must follow the stored row. */
function withWorkflow(id: string, title: string, executor: unknown): Database {
  const db = fresh();
  db.query(
    "INSERT INTO workflows(id,title,instruction,executor_json,params_json,timeout_seconds,created_at,updated_at) VALUES (?,?,?,?, '[]', 60, 'now', 'now')",
  ).run(id, title, `${title} 지시`, JSON.stringify(executor));
  return db;
}

describe("the app's jobs are ordinary scripts", () => {
  test("every job file is planted verbatim under the scripts root", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-jobs-"));
    try {
      expect(installJobs(root)).toHaveLength(JOB_FILES.length + 1);
      for (const file of JOB_FILES) {
        const shipped = readFileSync(join(JOB_SOURCE_ROOT, file), "utf8");
        expect(readFileSync(join(root, "jobs", file), "utf8")).toBe(shipped);
      }
      // The job's own import resolves beside it, not one level up where the image has none.
      expect(readFileSync(join(root, "jobs", ".digithive", "sdk.ts"), "utf8")).toContain(
        "DIGITHIVE_SDK_TOKEN",
      );
      // A second start rewrites nothing.
      expect(installJobs(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a rewritten definition stays findable by its title", () => {
    const db = withWorkflow("wf-collect", "연결 자료 수집 · A", {
      kind: "script",
      path: "@builtin/collection.ts",
      args: ["acct-a"],
      capabilities: ["account.read"],
    });
    // The store indexes on write; re-running the search reads the same row back.
    migrate(db);
    expect(searchWorkflowIds(db, { keyword: "연결 자료" }).map((hit) => hit.id)).toContain(
      "wf-collect",
    );
  });

  test("a collection workflow names the job path and its account argument", () => {
    expect(collectionExecutor("acct-a")).toEqual({
      kind: "script",
      path: "@builtin/collection.ts",
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

describe("@builtin/ names the app's own job", () => {
  test("an installed job starts and reaches the SDK, from a root that only has the install", async () => {
    // The deployed image has no `.digithive` above `jobs/`, so the installed job must
    // find the SDK beside itself. A run that never starts is the failure to catch.
    const root = mkdtempSync(join(tmpdir(), "jobs-installed-"));
    const db = new Database(":memory:");
    databases.push(db);
    db.exec("PRAGMA foreign_keys=ON");
    migrate(db);
    const events = new EventLog(db);
    const tools = createRegistry(
      jobTools({
        db,
        events,
        google: {
          db,
          events,
          config: { clientId: "", clientSecret: "", redirectUri: "" },
          vaultSecret: "",
        },
        canvas: { db, events, config: { baseUrl: "", token: "" } },
      }),
    );
    const bridge = new SdkBridge({ tools });
    try {
      installJobs(root);
      const run = enqueueRun(db, events, {
        goal: "collect",
        executor: collectionExecutor("acct-missing"),
      });
      const claimed = claimNext(db, events, "w1");
      if (!claimed) throw new Error("fixture claim");
      const outcome = await executeRun(
        {
          db,
          events,
          tools,
          policy: [],
          sdk: bridge,
          scriptsRoot: root,
          limits: WORK_LIMITS,
          stream: () => {
            throw new Error("a script run must not call the model");
          },
        },
        claimed,
      );
      // The account does not exist, so the job reports that and exits 1; what matters
      // is that it ran: it got past its import and reached the bridge.
      expect(outcome).toBe("failed");
      const result = z
        .object({ stderr: z.string().optional() })
        .parse(JSON.parse(getRun(db, run.id)?.resultJson ?? "{}"));
      expect(result.stderr ?? "").not.toContain("Cannot find module");
      expect(result.stderr ?? "").toContain("acct-missing");
    } finally {
      bridge.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a builtin path reads the shipped file, not a same-named one under the scripts root", async () => {
    const dir = mkdtempSync(join(tmpdir(), "builtin-"));
    await Bun.write(join(dir, "collection.ts"), 'console.log("owner copy");\n');
    const resolved = resolveScriptPath(dir, "@builtin/collection.ts");
    expect(resolved).toBe(realpathSync(join(JOB_SOURCE_ROOT, "collection.ts")));
    expect(resolved).not.toContain(dir);
  });

  test("a builtin path cannot leave the app's jobs directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "builtin-"));
    for (const path of ["@builtin/../src/server/main.ts", "@builtin/nested/job.ts", "@builtin/"])
      expect(() => resolveScriptPath(dir, path)).toThrow(/script_(path_outside_root|not_found)/);
  });

  test("forgetting the prefix is the same thing as naming a missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "builtin-"));
    expect(() => resolveScriptPath(dir, "collection.ts")).toThrow("script_not_found");
  });
});
