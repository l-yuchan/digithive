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
import { createSchedule, dispatchDueSchedules } from "../src/scheduler/schedules";
import { scheduleTools } from "../src/tools/schedules";

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
  return z.record(z.string(), z.unknown()).parse(
    JSON.parse(getRun(db, runId)?.resultJson ?? "{}"),
  );
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
    await writeScript(root, "sleep.ts", 'await Bun.sleep(60_000);\n');
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
    await writeScript(
      root,
      "loud.ts",
      'process.stdout.write("x".repeat(200_000));\n',
    );
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

describe("builtin and agent executors", () => {
  test("builtin runs through the injected scriptExecutor with the run signal", async () => {
    const { db, deps } = setup();
    const calls: { name: string; runId: string; aborted: boolean }[] = [];
    const withExecutor: WorkDeps = {
      ...deps,
      scriptExecutor: async (executor, context) => {
        calls.push({ name: executor.name, runId: context.runId, aborted: context.signal.aborted });
        return "동기화 완료";
      },
    };
    const run = enqueueRun(db, deps.events, {
      goal: "sync",
      executor: { kind: "builtin", name: "sync_sources" },
      timeoutSeconds: 120,
    });
    expect(await executeRun(withExecutor, requiredClaim(db, deps.events, "w1"))).toBe("succeeded");
    expect(calls).toEqual([{ name: "sync_sources", runId: run.id, aborted: false }]);
    expect(resultOf(db, run.id)["text"]).toBe("동기화 완료");
  });

  test("a builtin without an injected executor fails instead of falling back to the model", async () => {
    const { db, deps, modelCalls } = setup();
    const run = enqueueRun(db, deps.events, {
      goal: "no callback",
      executor: { kind: "builtin", name: "briefing" },
      timeoutSeconds: 60,
    });
    expect(await executeRun(deps, requiredClaim(db, deps.events, "w1"))).toBe("failed");
    expect(resultOf(db, run.id)["error"]).toBe("script_executor_unavailable");
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

  test("scheduler tools never execute work inline; only automatic dispatch enqueues", async () => {
    const { db, deps, modelCalls } = setup();
    let callbacks = 0;
    const toolDeps: WorkDeps = {
      ...deps,
      scriptExecutor: async () => {
        callbacks += 1;
        return "should not run inline";
      },
    };
    const tools = scheduleTools(toolDeps);
    const edit = tools.find((tool) => tool.name === "schedules_edit");
    if (!edit) throw new Error("fixture");
    const ToolCreated = z.object({ schedule: z.object({ id: z.string() }) });
    const created = ToolCreated.parse(
      JSON.parse(
        await edit.execute(
          {
            action: "create",
            title: "자동",
            instruction: "수집",
            enabled: true,
            trigger: {
              kind: "interval",
              everySeconds: 60,
              anchorAt: new Date(BASE).toISOString(),
            },
            executor: { kind: "builtin", name: "sync_sources" },
            timeoutSeconds: 60,
          },
          { runId: "conversation" },
        ),
      ),
    );
    expect(callbacks).toBe(0);
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM runs").get()?.n).toBe(0);

    db.query("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(
      new Date(BASE).toISOString(),
      created.schedule.id,
    );
    expect(dispatchDueSchedules(toolDeps, BASE + 60_000).enqueued).toBe(1);
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM runs").get()?.n).toBe(1);
    expect(callbacks).toBe(0);
    expect(modelCalls()).toBe(0);
  });

  test("scheduled agent runs receive shared clock/tool context and one system entry on resume", async () => {
    let round = 0;
    const requests: { role: string; content: string }[][] = [];
    const stream: StreamFn = async function* (messages) {
      requests.push(messages.map((message) => ({ role: message.role, content: message.content ?? "" })));
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
    expect(
      (requests.at(-1) ?? []).filter((message) => message.role === "system"),
    ).toHaveLength(1);
  });

  test("delegation completion and permission context survive the shared rebuild", async () => {
    let captured: { role: string; content: string }[] = [];
    const stream: StreamFn = async function* (messages) {
      captured = messages.map((message) => ({ role: message.role, content: message.content ?? "" }));
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
    const schedule = createSchedule(
      db,
      {
        title: "에이전트",
        instruction: "회의록을 요약한다",
        enabled: true,
        trigger: {
          kind: "interval",
          everySeconds: 3_600,
          anchorAt: new Date(BASE).toISOString(),
        },
        executor: { kind: "agent" },
        timeoutSeconds: 7_200,
      },
      BASE,
    );
    db.query("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(
      new Date(BASE).toISOString(),
      schedule.id,
    );
    expect(dispatchDueSchedules(deps, BASE + 1_000).enqueued).toBe(1);
    const row = db
      .query<{ run_id: string }, SQLQueryBindings[]>(
        "SELECT run_id FROM schedule_occurrences WHERE schedule_id = ?",
      )
      .get(schedule.id);
    const run = getRun(db, row?.run_id ?? "");
    expect(run?.origin).toBe("work");
    expect(run?.goal).toBe("회의록을 요약한다");
    expect(run?.executorJson).toBe('{"kind":"agent"}');
    expect(run?.timeoutSeconds).toBe(7_200);
    expect(run?.status).toBe("queued");
  });
});
