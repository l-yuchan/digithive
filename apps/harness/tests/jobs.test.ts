import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/store/db";
import { EventLog } from "../src/events/log";
import { migrateBuiltinExecutors } from "../src/store/job-migration";
import { installJobs, JOB_FILES, JOB_SOURCE_ROOT } from "../src/jobs/install";
import { jobTools, listJobAccounts } from "../src/tools/jobs";
import { allowedTools } from "../src/sdk/capabilities";
import { collectionExecutor } from "../src/workflows/collection";
import { searchWorkflowIds } from "../src/workflows/workflow-search";

const resources: { db: Database; root: string }[] = [];

afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.db.close();
    rmSync(resource.root, { recursive: true, force: true });
  }
});

function fresh(scriptsRoot = mkdtempSync(join(tmpdir(), "harness-jobs-"))) {
  const db = new Database(":memory:");
  resources.push({ db, root: scriptsRoot });
  db.exec("PRAGMA foreign_keys=ON");
  migrate(db);
  // The seeded definitions are builtin rows until `migrateBuiltinExecutors` runs in
  // the real startup path; these tests start from an empty workflow table instead.
  db.query("DELETE FROM schedules").run();
  db.query("DELETE FROM workflows").run();
  db.query("DELETE FROM workflows_fts").run();
  return { db, scriptsRoot };
}

function installScripts(scriptsRoot: string): void {
  mkdirSync(join(scriptsRoot, "jobs"), { recursive: true });
  for (const file of JOB_FILES)
    cpSync(join(JOB_SOURCE_ROOT, file), join(scriptsRoot, "jobs", file));
}

function insertWorkflow(db: Database, id: string, title: string, executor: unknown): void {
  db.query(
    "INSERT INTO workflows(id,title,instruction,executor_json,params_json,timeout_seconds,created_at,updated_at) VALUES (?,?,?,?, '[]', 60, 'now', 'now')",
  ).run(id, title, `${title} 지시`, JSON.stringify(executor));
}

function executorOf(db: Database, id: string): unknown {
  const row = db
    .query<{ executor_json: string }, [string]>("SELECT executor_json FROM workflows WHERE id = ?")
    .get(id);
  return row === null ? null : JSON.parse(row.executor_json);
}

describe("v11 turns stored builtin executors into script jobs", () => {
  test("a collection builtin keeps its account as the script argument and drops its source list", () => {
    const { db, scriptsRoot } = fresh();
    insertWorkflow(db, "wf-collect", "연결 자료 수집 · A", {
      kind: "builtin",
      name: "sync_sources",
      accountId: "acct-a",
      sources: ["gmail"],
    });
    const result = migrateBuiltinExecutors(db, { scriptsRoot });
    expect(result.rewritten).toBe(1);
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
    const { db, scriptsRoot } = fresh();
    insertWorkflow(db, "wf-brief", "아침 브리핑", { kind: "builtin", name: "briefing" });
    migrateBuiltinExecutors(db, { scriptsRoot });
    expect(executorOf(db, "wf-brief")).toEqual({
      kind: "script",
      path: "jobs/briefing.ts",
      args: [],
      capabilities: ["account.read", "mail.send"],
    });
  });

  test("a seeded definition naming a job file that was never installed is repaired", () => {
    const { db, scriptsRoot } = fresh();
    // The seed published this path before the file existed, so it could not run.
    insertWorkflow(db, "wf-system-briefing-morning", "아침 브리핑", {
      kind: "script",
      path: "jobs/briefing.ts",
      args: [],
    });
    const result = migrateBuiltinExecutors(db, { scriptsRoot });
    expect(result.repaired).toBe(1);
    expect(executorOf(db, "wf-system-briefing-morning")).toEqual({
      kind: "script",
      path: "jobs/briefing.ts",
      args: [],
      capabilities: ["account.read", "mail.send"],
    });
  });

  test("the owner's own missing script is left alone", () => {
    const { db, scriptsRoot } = fresh();
    insertWorkflow(db, "wf-mine", "내 작업", { kind: "script", path: "mine/report.ts", args: [] });
    const result = migrateBuiltinExecutors(db, { scriptsRoot });
    expect(result).toEqual({ rewritten: 0, repaired: 0 });
    expect(executorOf(db, "wf-mine")).toMatchObject({ path: "mine/report.ts" });
  });

  test("running again rewrites nothing", () => {
    const { db, scriptsRoot } = fresh();
    installScripts(scriptsRoot);
    insertWorkflow(db, "wf-collect", "수집", {
      kind: "builtin",
      name: "sync_sources",
      accountId: "acct-a",
    });
    migrateBuiltinExecutors(db, { scriptsRoot });
    expect(migrateBuiltinExecutors(db, { scriptsRoot })).toEqual({ rewritten: 0, repaired: 0 });
  });

  test("the search index still finds a rewritten definition by its title", () => {
    const { db, scriptsRoot } = fresh();
    installScripts(scriptsRoot);
    insertWorkflow(db, "wf-collect", "연결 자료 수집 · A", {
      kind: "builtin",
      name: "sync_sources",
      accountId: "acct-a",
    });
    migrateBuiltinExecutors(db, { scriptsRoot });
    expect(searchWorkflowIds(db, { keyword: "연결 자료" }).map((hit) => hit.id)).toEqual([
      "wf-collect",
    ]);
  });
});

describe("the app's jobs are ordinary scripts", () => {
  test("the installer copies both jobs into the scripts root", () => {
    const scriptRoot = mkdtempSync(join(tmpdir(), "harness-install-"));
    resources.push({ db: new Database(":memory:"), root: scriptRoot });
    expect(installJobs(scriptRoot)).toHaveLength(JOB_FILES.length);
    for (const file of JOB_FILES) {
      const installed = readFileSync(join(scriptRoot, "jobs", file), "utf8");
      // The import is absolute, because the relative `../.digithive/sdk.ts` of the
      // source would resolve against `<root>/jobs`, i.e. one level too deep.
      expect(installed).toContain(
        JSON.stringify(join(scriptRoot, ".digithive", "sdk.ts").split("\\").join("/")),
      );
    }
    // A second run changes nothing.
    expect(installJobs(scriptRoot)).toEqual([]);
  });

  test("a root that is the app directory gets an absolute SDK import instead", () => {
    // In that layout `<root>/../.digithive/sdk.ts` is outside the root, which the
    // script path check refuses, so the import must not climb out.
    const appShaped = mkdtempSync(join(tmpdir(), "harness-app-"));
    resources.push({ db: new Database(":memory:"), root: appShaped });
    const jobs = join(appShaped, "jobs");
    mkdirSync(jobs, { recursive: true });
    cpSync(join(JOB_SOURCE_ROOT, "collection.ts"), join(jobs, "collection.ts"));
    expect(installJobs(appShaped)).toHaveLength(JOB_FILES.length);
    const source = readFileSync(join(jobs, "collection.ts"), "utf8");
    expect(source).toContain(join(appShaped, ".digithive", "sdk.ts").split("\\").join("/"));
    expect(source).not.toContain('"../.digithive/sdk.ts"');
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
    const { db } = fresh();
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
    const { db } = fresh();
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
