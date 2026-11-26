import { afterEach, describe, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { z } from "zod";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/store/db";
import { EventLog } from "../src/events/log";
import { createRegistry } from "../src/tools/registry";
import { builtinTools, WORK_POLICY } from "../src/tools/builtins";
import type { StreamFn } from "../src/providers/openai";
import {
  claimNext,
  decideApproval,
  enqueueRun,
  executeRun,
  getRun,
  type WorkDeps,
} from "../src/surfaces/work/runner";
import { cancelRun } from "../src/surfaces/work/cancel";
import { resolveScriptPath } from "../src/surfaces/work/script";
import { createWorkflow } from "../src/workflows/workflow-store";
import { createBinding } from "../src/scheduler/schedule-store";
import { dispatchDueSchedules } from "../src/scheduler/schedule-dispatch";
import { RunExecutorSchema } from "../src/core/executor";
import { scheduleTools } from "../src/tools/schedules";
import { workflowTools } from "../src/tools/workflows";

/** A definition plus its trigger: the two rows a scheduled run needs. */
function scheduledFixture(
  db: Database,
  deps: { readonly events: EventLog },
  input: {
    readonly title: string;
    readonly instruction: string;
    readonly executor: Parameters<typeof createWorkflow>[1]["executor"];
    readonly timeoutSeconds?: number;
    readonly everySeconds?: number;
  },
  now = BASE,
) {
  const workflow = createWorkflow(
    db,
    {
      title: input.title,
      instruction: input.instruction,
      executor: input.executor,
      params: [],
      ...(input.timeoutSeconds === undefined ? {} : { timeoutSeconds: input.timeoutSeconds }),
    },
    now,
    deps.events,
  );
  const binding = createBinding(
    db,
    {
      workflowId: workflow.id,
      trigger: {
        kind: "interval",
        everySeconds: input.everySeconds ?? 60,
        anchorAt: new Date(now).toISOString(),
      },
    },
    now,
    deps.events,
  );
  return { workflow, binding };
}

const resources: { db: Database; root: string; outside: string }[] = [];
afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.db.close();
    rmSync(resource.root, { recursive: true, force: true });
    rmSync(resource.outside, { recursive: true, force: true });
  }
});

function setup(stream?: StreamFn) {
  const root = mkdtempSync(join(tmpdir(), "schedule-scripts-"));
  const outside = mkdtempSync(join(tmpdir(), "schedule-outside-"));
  const db = new Database(":memory:");
  resources.push({ db, root, outside });
  db.exec("PRAGMA foreign_keys=ON");
  migrate(db);
  db.query("DELETE FROM schedules").run();
  db.query("DELETE FROM workflows").run();
  db.query("DELETE FROM workflows_fts").run();
  const events = new EventLog(db);
  let modelCalls = 0;
  const defaultStream: StreamFn = async function* () {
    modelCalls += 1;
    yield { type: "done", finishReason: "stop" };
    throw new Error("model_must_not_be_called");
  };
  const deps: WorkDeps = {
    db,
    events,
    stream: stream ?? defaultStream,
    tools: createRegistry(builtinTools({ root })),
    policy: WORK_POLICY,
    scriptsRoot: root,
    limits: {
      firstTokenMs: 2_000,
      idleMs: 2_000,
      toolMs: 1_000,
      maxOutputTokens: 100,
      maxToolRounds: 2,
      totalMs: 10_000,
    },
    maxConcurrent: 2,
    leaseMs: 60_000,
  };
  return { db, events, deps, root, outside, modelCalls: () => modelCalls };
}

function requiredClaim(...args: Parameters<typeof claimNext>) {
  const run = claimNext(...args);
  if (!run) throw new Error("fixture claim");
  return run;
}

async function writeScript(root: string, name: string, source: string): Promise<void> {
  await Bun.write(join(root, name), source);
}

function resultOf(db: Database, runId: string): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(JSON.parse(getRun(db, runId)?.resultJson ?? "{}"));
}

function runState(db: Database, runId: string): { role: string; content: string | null }[] {
  return z
    .object({
      messages: z.array(z.object({ role: z.string(), content: z.string().nullable() })),
    })
    .parse(JSON.parse(getRun(db, runId)?.stateJson ?? "{}")).messages;
}

const BASE = Date.parse("2026-01-01T00:00:00.000Z");

describe("local script execution", () => {
  test("a real TypeScript file runs to success without any model request", async () => {
    const { db, deps, root, modelCalls } = setup();
    await writeScript(root, "ok.ts", 'console.log("hello-from-script");\n');
    const run = enqueueRun(db, deps.events, {
      goal: "script run",
      executor: { kind: "script", path: "ok.ts", args: [] },
      timeoutSeconds: 60,
    });
    const outcome = await executeRun(deps, requiredClaim(db, deps.events, "w1"));
    expect(outcome).toBe("succeeded");
    const result = resultOf(db, run.id);
    expect(result["text"]).toContain("hello-from-script");
    expect(result["exitCode"]).toBe(0);
    expect(getRun(db, run.id)?.status).toBe("succeeded");
    expect(modelCalls()).toBe(0);
  });

  test("a failing script records stderr and its exit code as a failed run", async () => {
    const { db, deps, root } = setup();
    await writeScript(root, "fail.ts", 'console.error("boom");\nprocess.exit(3);\n');
    const run = enqueueRun(db, deps.events, {
      goal: "failing script",
      executor: { kind: "script", path: "fail.ts", args: [] },
      timeoutSeconds: 60,
    });
    expect(await executeRun(deps, requiredClaim(db, deps.events, "w1"))).toBe("failed");
    const result = resultOf(db, run.id);
    expect(result["error"]).toBe("script_exit_3");
    expect(result["stderr"]).toContain("boom");
    expect(result["exitCode"]).toBe(3);
  });

  test("absolute, traversal and symlink paths cannot escape the scripts root", async () => {
    const { db, deps, root, outside } = setup();
    const escape = join(outside, "escape.ts");
    await Bun.write(escape, 'console.log("escaped");\n');
    expect(() => resolveScriptPath(root, escape)).toThrow("script_path_outside_root");
    expect(() => resolveScriptPath(root, "../escape.ts")).toThrow("script_path_outside_root");

    for (const path of [escape, "../escape.ts"]) {
      const run = enqueueRun(db, deps.events, {
        goal: "escape",
        executor: { kind: "script", path, args: [] },
        timeoutSeconds: 60,
      });
      expect(await executeRun(deps, requiredClaim(db, deps.events, "w1"))).toBe("failed");
      expect(resultOf(db, run.id)["error"]).toBe("script_path_outside_root");
    }

    const link = join(root, "link.ts");
    let linked = false;
    try {
      symlinkSync(escape, link);
      linked = true;
    } catch {
      linked = false;
    }
    if (linked) {
      expect(() => resolveScriptPath(root, "link.ts")).toThrow("script_path_outside_root");
      const run = enqueueRun(db, deps.events, {
        goal: "symlink escape",
        executor: { kind: "script", path: "link.ts", args: [] },
        timeoutSeconds: 60,
      });
      expect(await executeRun(deps, requiredClaim(db, deps.events, "w1"))).toBe("failed");
      expect(resultOf(db, run.id)["error"]).toBe("script_path_outside_root");
    }
  });

  test("cancelling a running script kills the process and settles cancelled", async () => {
    const { db, deps, root } = setup();
    const marker = join(root, "started.txt");
    await writeScript(
      root,
      "slow.ts",
      'await Bun.write("started.txt","yes");\nawait Bun.sleep(30_000);\nconsole.log("finished");\n',
    );
    const run = enqueueRun(db, deps.events, {
      goal: "slow",
      executor: { kind: "script", path: "slow.ts", args: [] },
      timeoutSeconds: 60,
    });
    const claimed = requiredClaim(db, deps.events, "w1");
    const started = Date.now();
    const executing = executeRun(deps, claimed);
    for (let i = 0; i < 200 && !existsSync(marker); i += 1) await Bun.sleep(20);
    expect(existsSync(marker)).toBe(true);
    const cancelled = cancelRun(deps, run.id);
    expect(cancelled?.status).toBe("cancelled");
    const outcome = await Promise.race([
      executing,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5_000)),
    ]);
    expect(outcome).toBe("cancelled");
    expect(Date.now() - started).toBeLessThan(5_000);
    const settled = getRun(db, run.id);
    expect(settled?.status).toBe("cancelled");
    expect(settled?.cancelIntent).toBe("user");
  });

  test("worker shutdown aborts the script promptly as host_restart, not timeout", async () => {
    const { db, deps, root } = setup();
    await writeScript(root, "slow2.ts", 'await Bun.sleep(30_000);\nconsole.log("finished");\n');
    const run = enqueueRun(db, deps.events, {
      goal: "shutdown",
      executor: { kind: "script", path: "slow2.ts", args: [] },
      timeoutSeconds: 60,
    });
    const shutdown = new AbortController();
    const executing = executeRun(
      { ...deps, shutdownSignal: shutdown.signal },
      requiredClaim(db, deps.events, "w1"),
    );
    setTimeout(() => shutdown.abort(), 150);
    const outcome = await Promise.race([
      executing,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5_000)),
    ]);
    expect(outcome).toBe("interrupted");
    const settled = getRun(db, run.id);
    expect(settled?.status).toBe("interrupted");
    expect(settled?.cancelIntent).toBe("host_restart");
  });

  test("a short deps.limits totalMs still bounds a run whose persisted timeout is hours", async () => {
    const { db, deps, root } = setup();
    await writeScript(root, "sleep.ts", "await Bun.sleep(60_000);\n");
    const run = enqueueRun(db, deps.events, {
      goal: "bounded",
      executor: { kind: "script", path: "sleep.ts", args: [] },
      timeoutSeconds: 3_600,
    });
    const started = Date.now();
    const limits = deps.limits;
    if (!limits) throw new Error("fixture limits");
    const outcome = await executeRun(
      { ...deps, limits: { ...limits, totalMs: 300 } },
      requiredClaim(db, deps.events, "w1"),
    );
    expect(outcome).toBe("interrupted");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(getRun(db, run.id)?.cancelIntent).toBe("timeout");
  });

  test("script output is bounded and marked truncated", async () => {
    const { db, deps, root } = setup();
    await writeScript(root, "loud.ts", 'process.stdout.write("x".repeat(200_000));\n');
    const run = enqueueRun(db, deps.events, {
      goal: "loud",
      executor: { kind: "script", path: "loud.ts", args: [] },
      timeoutSeconds: 60,
    });
    expect(await executeRun(deps, requiredClaim(db, deps.events, "w1"))).toBe("succeeded");
    const result = resultOf(db, run.id);
    expect(String(result["stdout"]).length).toBeLessThanOrEqual(64_000);
    expect(result["truncated"]).toBe(true);
  });
});

describe("script and agent executors", () => {
  test("a script is the only non-agent kind: a builtin executor no longer exists", () => {
    // The app's own collection and briefing jobs are scripts; the schema must refuse
    // a stored builtin rather than quietly running one.
    expect(RunExecutorSchema.safeParse({ kind: "builtin", name: "sync_sources" }).success).toBe(
      false,
    );
    expect(
      RunExecutorSchema.parse({
        kind: "script",
        path: "@builtin/collection.ts",
        args: ["acct-a"],
        capabilities: ["account.read"],
      }),
    ).toMatchObject({ kind: "script", path: "@builtin/collection.ts", args: ["acct-a"] });
  });

  test("a script without a scripts root fails instead of falling back to the model", async () => {
    const { db, deps, modelCalls } = setup();
    const run = enqueueRun(db, deps.events, {
      goal: "no root",
      executor: { kind: "script", path: "@builtin/briefing.ts", args: [] },
      timeoutSeconds: 60,
    });
    expect(
      await executeRun(
        (({ scriptsRoot: _root, ...rest }) => rest)(deps),
        requiredClaim(db, deps.events, "w1"),
      ),
    ).toBe("failed");
    expect(resultOf(db, run.id)["error"]).toBe("scripts_root_unavailable");
    expect(modelCalls()).toBe(0);
  });

  test("agent executor keeps the old approval pause/resume behavior", async () => {
    let round = 0;
    const stream: StreamFn = async function* () {
      if (++round === 1) {
        yield {
          type: "tool_call",
          id: "c1",
          name: "external_action",
          arguments: JSON.stringify({ summary: "메일" }),
        };
        yield { type: "done", finishReason: "tool_calls" };
      } else {
        yield { type: "text_delta", text: "끝" };
        yield { type: "done", finishReason: "stop" };
      }
    };
    const { db, deps } = setup(stream);
    const run = enqueueRun(db, deps.events, {
      goal: "승인 흐름",
      executor: { kind: "agent" },
      timeoutSeconds: 900,
    });
    expect(run.executorJson).toBe('{"kind":"agent"}');
    expect(run.timeoutSeconds).toBe(900);
    const claimed = requiredClaim(db, deps.events, "w1");
    expect(await executeRun(deps, claimed)).toBe("paused");
    expect(getRun(db, run.id)?.status).toBe("awaiting_approval");
    const approval = db
      .query<{ id: string }, SQLQueryBindings[]>("SELECT id FROM approvals WHERE run_id = ?")
      .get(run.id);
    if (!approval) throw new Error("fixture");
    decideApproval(deps, { runId: run.id, approvalId: approval.id, decision: "approve" });
    const resumed = requiredClaim(db, deps.events, "w2");
    expect(await executeRun(deps, resumed)).toBe("succeeded");
    expect(getRun(db, run.id)?.status).toBe("succeeded");
  });

  test("관리 도구는 실행을 만들지 않고, workflow_run만 그 자리에서 실행한다", async () => {
    const { db, deps, root } = setup();
    const calls = { count: 0 };
    await writeScript(
      root,
      "jobs/mark.ts",
      `const fs = await import("node:fs");\nfs.appendFileSync(${JSON.stringify(join(root, "calls.log"))}, "x");\nconsole.log("executed");\n`,
    );
    db.exec("CREATE TABLE IF NOT EXISTS unrelated (id TEXT)");
    const toolDeps: WorkDeps = deps;
    const workflows = workflowTools({ db, events: deps.events, work: () => toolDeps });
    const createTool = workflows.find((tool) => tool.name === "workflow_create");
    const runTool = workflows.find((tool) => tool.name === "workflow_run");
    if (!createTool || !runTool) throw new Error("fixture");
    const created = z.object({ workflow: z.object({ id: z.string() }) }).parse(
      JSON.parse(
        await createTool.execute(
          {
            title: "자동",
            instruction: "수집",
            executor: { kind: "script", path: "jobs/mark.ts", args: [] },
          },
          { runId: "conversation" },
        ),
      ),
    );
    const scheduleTool = scheduleTools({ db, events: deps.events }).find(
      (tool) => tool.name === "schedule_create",
    );
    if (!scheduleTool) throw new Error("fixture");
    await scheduleTool.execute(
      {
        workflowId: created.workflow.id,
        trigger: { kind: "interval", everySeconds: 60, anchorAt: new Date(BASE).toISOString() },
      },
      { runId: "conversation" },
    );
    const executions = () => {
      const file = Bun.file(join(root, "calls.log"));
      return file.exists();
    };
    expect(await executions()).toBe(false);
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM runs").get()?.n).toBe(0);

    db.query("UPDATE schedules SET next_run_at = ? WHERE workflow_id = ?").run(
      new Date(BASE).toISOString(),
      created.workflow.id,
    );
    expect(dispatchDueSchedules(toolDeps, BASE + 60_000).enqueued).toBe(1);
    // Dispatching only queues: the script has not run yet.
    expect(await executions()).toBe(false);

    const inline = z
      .object({ runId: z.string(), status: z.string() })
      .parse(
        JSON.parse(await runTool.execute({ id: created.workflow.id }, { runId: "conversation" })),
      );
    expect(inline.status).toBe("succeeded");
    expect(await executions()).toBe(true);
    expect(calls.count).toBe(0);
  });

  test("a collection schedule runs its account's job with the account as the argument", async () => {
    const { db, deps, root } = setup();
    db.query(
      "INSERT INTO integration_accounts(id,provider,subject,email,label,created_at,updated_at) VALUES ('acct-a','google','sub-a','a@example.com','A','2026-01-01','2026-01-01'),('acct-b','google','sub-b','b@example.com','B','2026-01-01','2026-01-01')",
    ).run();
    for (const id of ["acct-a", "acct-b"]) {
      db.query("INSERT INTO account_sources(account_id,source) VALUES (?,?),(?,?)").run(
        id,
        "calendar",
        id,
        "gmail",
      );
    }
    // A stand-in the owner wrote: it records the argument it was given. The account's
    // collection workflow names it, so the schedule path is what runs here; a
    // `@builtin/` path reads the app's own job and ignores the scripts root.
    await writeScript(
      root,
      "jobs/collect-a.ts",
      "console.log(JSON.stringify({ accountId: process.argv[2] ?? null }));\n",
    );
    const { binding } = scheduledFixture(db, deps, {
      title: "A 수집",
      instruction: "A 계정의 자료을 모읍니다.",
      executor: {
        kind: "script",
        path: "jobs/collect-a.ts",
        args: ["acct-a"],
        capabilities: ["account.read"],
      },
      timeoutSeconds: 60,
    });
    db.query("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(
      new Date(BASE).toISOString(),
      binding.id,
    );
    expect(dispatchDueSchedules(deps, BASE + 60_000).enqueued).toBe(1);
    expect(await executeRun(deps, requiredClaim(db, deps.events, "w1"))).toBe("succeeded");
    const run = db
      .query<{ id: string }, []>("SELECT id FROM runs WHERE workflow_id IS NOT NULL LIMIT 1")
      .get();
    const text = resultOf(db, run?.id ?? "")["text"];
    expect(typeof text === "string" ? JSON.parse(text) : null).toEqual({ accountId: "acct-a" });

    // The job itself refuses a missing account: it exits 2 with the reason.
    const nameless = enqueueRun(db, deps.events, {
      goal: "계정 없음",
      executor: {
        kind: "script",
        path: "jobs/no-account.ts",
        args: [],
        capabilities: ["account.read"],
      },
      timeoutSeconds: 60,
    });
    await writeScript(
      root,
      "jobs/no-account.ts",
      'console.error("수집할 계정 id가 필요합니다.");\nprocess.exit(2);\n',
    );
    expect(await executeRun(deps, requiredClaim(db, deps.events, "w2"))).toBe("failed");
    expect(resultOf(db, nameless.id)["exitCode"]).toBe(2);
    expect(resultOf(db, nameless.id)["stderr"]).toContain("계정 id가 필요합니다");
  });

  test("scheduled agent runs receive shared clock/tool context and one system entry on resume", async () => {
    let round = 0;
    const requests: { role: string; content: string }[][] = [];
    const stream: StreamFn = async function* (messages) {
      requests.push(
        messages.map((message) => ({ role: message.role, content: message.content ?? "" })),
      );
      if (++round === 1) {
        yield {
          type: "tool_call",
          id: "ctx",
          name: "external_action",
          arguments: JSON.stringify({ summary: "게시" }),
        };
        yield { type: "done", finishReason: "tool_calls" };
      } else {
        yield { type: "text_delta", text: "컨텍스트 확인" };
        yield { type: "done", finishReason: "stop" };
      }
    };
    const { db, deps } = setup(stream);
    const run = enqueueRun(db, deps.events, {
      goal: "오늘 일정 요약",
      executor: { kind: "agent" },
      timeoutSeconds: 600,
    });
    expect(await executeRun(deps, requiredClaim(db, deps.events, "w1"))).toBe("paused");
    const paused = runState(db, run.id);
    const systems = paused.filter((message) => message.role === "system");
    expect(systems).toHaveLength(1);
    expect(systems[0]?.content).toContain("현재 시각:");
    expect(systems[0]?.content).toContain("external_action");

    const approval = db
      .query<{ id: string }, SQLQueryBindings[]>("SELECT id FROM approvals WHERE run_id = ?")
      .get(run.id);
    if (!approval) throw new Error("fixture");
    decideApproval(deps, { runId: run.id, approvalId: approval.id, decision: "approve" });
    expect(await executeRun(deps, requiredClaim(db, deps.events, "w2"))).toBe("succeeded");
    expect(runState(db, run.id).filter((message) => message.role === "system")).toHaveLength(1);
    expect((requests.at(-1) ?? []).filter((message) => message.role === "system")).toHaveLength(1);
  });

  test("delegation completion and permission context survive the shared rebuild", async () => {
    let captured: { role: string; content: string }[] = [];
    const stream: StreamFn = async function* (messages) {
      captured = messages.map((message) => ({
        role: message.role,
        content: message.content ?? "",
      }));
      yield { type: "done", finishReason: "stop" };
    };
    const { db, deps } = setup(stream);
    const run = enqueueRun(db, deps.events, {
      goal: "조사",
      origin: "delegation",
      delegation: {
        goal: "조사",
        inputRefs: ["mail:1"],
        permissionProfile: "read-only",
        budget: { maxMicroUsd: 100, maxToolCalls: 1 },
        completionCondition: "출처가 붙은 요약",
      },
      executor: { kind: "agent" },
      timeoutSeconds: 60,
    });
    expect(await executeRun(deps, requiredClaim(db, deps.events, "w1"))).toBe("succeeded");
    const system = captured.find((message) => message.role === "system")?.content ?? "";
    expect(system).toContain("현재 시각:");
    expect(system).toContain("Completion condition: 출처가 붙은 요약");
    expect(system).toContain("Permission profile: read-only");
    expect(getRun(db, run.id)?.status).toBe("succeeded");
  });
});

describe("schedule dispatch integration", () => {
  test("a dispatch schedules an agent run with its instruction and timeout", () => {
    const { db, deps } = setup();
    const { binding } = scheduledFixture(db, deps, {
      title: "에이전트",
      instruction: "회의록을 요약한다",
      executor: { kind: "agent" },
      timeoutSeconds: 7_200,
      everySeconds: 3_600,
    });
    db.query("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(
      new Date(BASE).toISOString(),
      binding.id,
    );
    expect(dispatchDueSchedules(deps, BASE + 1_000).enqueued).toBe(1);
    const row = db
      .query<{ run_id: string }, SQLQueryBindings[]>(
        "SELECT run_id FROM schedule_occurrences WHERE schedule_id = ?",
      )
      .get(binding.id);
    const run = getRun(db, row?.run_id ?? "");
    expect(run?.origin).toBe("work");
    expect(run?.goal).toBe("회의록을 요약한다");
    expect(run?.executorJson).toBe('{"kind":"agent"}');
    expect(run?.timeoutSeconds).toBe(7_200);
    expect(run?.status).toBe("queued");
  });
});
