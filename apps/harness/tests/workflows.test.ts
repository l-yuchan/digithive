import { afterEach, describe, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { z } from "zod";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate } from "../src/store/db";
import { EventLog } from "../src/events/log";
import { createRegistry } from "../src/tools/registry";
import { builtinTools, WORK_POLICY } from "../src/tools/builtins";
import type { AdapterEvent, StreamFn } from "../src/providers/openai";
import { enqueueRun, getRun, type WorkDeps } from "../src/surfaces/work/runner";
import { runWorkflowInline } from "../src/surfaces/work/inline-run";
import {
  WorkflowError,
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  listWorkflows,
  runsForWorkflow,
  updateWorkflow,
} from "../src/workflows/workflow-store";
import { resolveWorkflowParams } from "../src/workflows/workflow-params";
import { searchWorkflowIds } from "../src/workflows/workflow-search";
import { enqueueWorkflowRun } from "../src/workflows/workflow-run";
import { createBinding, listBindingViews } from "../src/scheduler/schedule-store";

const resources: { db: Database; root: string }[] = [];
const BASE = Date.parse("2026-01-01T00:00:00.000Z");

afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.db.close();
    rmSync(resource.root, { recursive: true, force: true });
  }
});

function fresh() {
  const root = mkdtempSync(join(tmpdir(), "harness-workflows-"));
  const db = new Database(":memory:");
  resources.push({ db, root });
  db.exec("PRAGMA foreign_keys=ON");
  migrate(db);
  db.query("DELETE FROM schedules").run();
  db.query("DELETE FROM workflows").run();
  db.query("DELETE FROM workflows_fts").run();
  const events = new EventLog(db);
  return { db, events, root };
}

function count(db: Database, sql: string): number {
  const row = db.query<{ n: number }, SQLQueryBindings[]>(sql).get();
  return row?.n ?? 0;
}

function agentDefinition(): { title: string; instruction: string; executor: { kind: "agent" } } {
  return { title: "정리", instruction: "받은 편지를 정리한다", executor: { kind: "agent" } };
}

function thrown(fn: () => unknown): WorkflowError {
  try {
    fn();
  } catch (error) {
    if (error instanceof WorkflowError) return error;
    throw error;
  }
  throw new Error("expected a WorkflowError");
}

const intervalTrigger = {
  kind: "interval" as const,
  everySeconds: 60,
  anchorAt: new Date(BASE).toISOString(),
};

describe("workflow store", () => {
  test("a definition is created without any trigger and listed with its bindings", () => {
    const { db, events } = fresh();
    const workflow = createWorkflow(
      db,
      { ...agentDefinition(), params: [{ name: "day", type: "string" }] },
      BASE,
      events,
    );
    expect(workflow.id.length).toBeGreaterThan(0);
    expect(count(db, "SELECT count(*) AS n FROM schedules")).toBe(0);

    const binding = createBinding(
      db,
      {
        workflowId: workflow.id,
        trigger: { kind: "daily", time: "07:30", timeZone: "Asia/Seoul" },
        args: { day: "today" },
      },
      BASE,
      events,
    );
    const views = listWorkflows(db);
    expect(views).toHaveLength(1);
    expect(views[0]?.schedules.map((row) => row.id)).toEqual([binding.id]);
    expect(listBindingViews(db, workflow.id)[0]?.workflowTitle).toBe("정리");
  });

  test("deleting a definition with a binding is refused until cascaded, and history stays", () => {
    const { db, events } = fresh();
    const workflow = createWorkflow(db, agentDefinition(), BASE, events);
    createBinding(db, { workflowId: workflow.id, trigger: intervalTrigger }, BASE, events);
    const prepared = enqueueWorkflowRun({ db, events }, workflow.id, {
      triggerKind: "manual",
      now: BASE,
    });

    const refusal = thrown(() => deleteWorkflow(db, workflow.id, { events }));
    expect(refusal.code).toBe("schedules_present");
    expect(z.array(z.object({ id: z.string() })).parse(refusal.detail)).toHaveLength(1);

    const removed = deleteWorkflow(db, workflow.id, { cascade: true, events });
    expect(removed.removedSchedules).toHaveLength(1);
    expect(getWorkflow(db, workflow.id)).toBeNull();
    expect(count(db, "SELECT count(*) AS n FROM schedules")).toBe(0);
    const run = getRun(db, prepared.run.id);
    expect(run?.workflowId).toBe(workflow.id);
    expect(run?.workflowTitle).toBe("정리");
  });

  test("a parameter change that breaks a binding is refused and force keeps the valid values", () => {
    const { db, events } = fresh();
    const workflow = createWorkflow(
      db,
      {
        ...agentDefinition(),
        params: [
          { name: "day", type: "string" },
          { name: "count", type: "number", default: 1 },
        ],
      },
      BASE,
      events,
    );
    createBinding(
      db,
      { workflowId: workflow.id, trigger: intervalTrigger, args: { day: "today", count: 3 } },
      BASE,
      events,
    );

    const refusal = thrown(() =>
      updateWorkflow(db, workflow.id, { params: [{ name: "other", type: "string" }] }, { events }),
    );
    expect(refusal.code).toBe("schedule_args_invalid");
    const broken = z
      .array(z.object({ id: z.string(), errors: z.array(z.string()) }))
      .parse(refusal.detail);
    expect(broken).toHaveLength(1);
    expect(broken[0]?.errors).toEqual(
      expect.arrayContaining(["unknown_param:day", "unknown_param:count"]),
    );

    const forced = updateWorkflow(
      db,
      workflow.id,
      { params: [{ name: "other", type: "string", default: "x" }] },
      { events, force: true },
    );
    expect(forced.rebound).toHaveLength(1);
    expect(listBindingViews(db, workflow.id)[0]?.args).toEqual({});
  });

  test("search offers keyword, regex and bm25 over title and instruction", () => {
    const { db, events } = fresh();
    createWorkflow(
      db,
      {
        title: "아침 브리핑",
        instruction: "수집된 자료로 브리핑을 만든다",
        executor: { kind: "agent" },
      },
      BASE,
      events,
    );
    createWorkflow(
      db,
      {
        title: "연결 자료 수집",
        instruction: "계정의 정보를 증분 수집한다",
        executor: { kind: "agent" },
      },
      BASE + 1,
      events,
    );

    expect(searchWorkflowIds(db, { keyword: "브리핑" })).toHaveLength(1);
    // Every term must appear somewhere in title+instruction, in any order.
    expect(searchWorkflowIds(db, { keyword: "자료 수집" })).toHaveLength(2);
    expect(searchWorkflowIds(db, { keyword: "증분" })).toHaveLength(1);
    expect(searchWorkflowIds(db, { regex: "^(아침|저녁)" })).toHaveLength(1);
    expect(searchWorkflowIds(db, { regex: "^연결" })).toHaveLength(1);
    const bm25 = searchWorkflowIds(db, { bm25: "브리핑" });
    expect(bm25).toHaveLength(1);
    expect(bm25[0]?.score).toBeLessThan(0);
    expect(() => searchWorkflowIds(db, { bm25: "브리" })).toThrow("search_query_too_short");
    expect(() => searchWorkflowIds(db, { regex: "(" })).toThrow("search_invalid_regex");
    expect(() => searchWorkflowIds(db, { keyword: "a", bm25: "abc" })).toThrow();
  });
});

describe("parameters", () => {
  test("defaults fill in, unknown keys and wrong types are refused", () => {
    const declared = [
      { name: "day", type: "string" as const, required: true, description: undefined },
      {
        name: "count",
        type: "number" as const,
        required: false,
        default: 2,
        description: undefined,
      },
    ];
    expect(resolveWorkflowParams(declared, { day: "월" })).toEqual({
      ok: true,
      values: { day: "월", count: 2 },
    });
    expect(resolveWorkflowParams(declared, {})).toEqual({
      ok: false,
      errors: ["missing_param:day"],
    });
    expect(resolveWorkflowParams(declared, { day: "월", extra: 1 })).toEqual({
      ok: false,
      errors: ["unknown_param:extra"],
    });
    expect(resolveWorkflowParams(declared, { day: 1 })).toEqual({
      ok: false,
      errors: ["invalid_param:day"],
    });
  });

  test("a run records the values it used and refuses an invalid invocation before creating a row", () => {
    const { db, events } = fresh();
    const workflow = createWorkflow(
      db,
      {
        ...agentDefinition(),
        params: [
          { name: "day", type: "string", required: true },
          { name: "count", type: "number", default: 2 },
        ],
      },
      BASE,
      events,
    );
    const prepared = enqueueWorkflowRun({ db, events }, workflow.id, {
      args: { day: "월" },
      triggerKind: "manual",
      now: BASE,
    });
    expect(prepared.params).toEqual({ day: "월", count: 2 });
    expect(z.record(z.string(), z.unknown()).parse(JSON.parse(prepared.run.paramsJson))).toEqual({
      day: "월",
      count: 2,
    });
    expect(prepared.run.triggerKind).toBe("manual");
    expect(prepared.run.workflowTitle).toBe("정리");

    const before = count(db, "SELECT count(*) AS n FROM runs");
    const refusal = thrown(() =>
      enqueueWorkflowRun({ db, events }, workflow.id, {
        args: { other: 1 },
        triggerKind: "manual",
        now: BASE,
      }),
    );
    expect(refusal.code).toBe("invalid_params");
    expect(count(db, "SELECT count(*) AS n FROM runs")).toBe(before);
  });

  test("a workflow chain stops at depth three", () => {
    const { db, events } = fresh();
    const workflow = createWorkflow(db, agentDefinition(), BASE, events);
    const root = enqueueRun(db, events, { goal: "1", now: BASE });
    const second = enqueueRun(db, events, { goal: "2", parentRunId: root.id, now: BASE });
    const third = enqueueRun(db, events, { goal: "3", parentRunId: second.id, now: BASE });
    expect(() =>
      enqueueWorkflowRun({ db, events }, workflow.id, {
        triggerKind: "tool",
        parentRunId: third.id,
        now: BASE,
      }),
    ).toThrow("workflow_depth_exceeded");
    expect(
      enqueueWorkflowRun({ db, events }, workflow.id, {
        triggerKind: "tool",
        parentRunId: second.id,
        now: BASE,
      }).run.id,
    ).toBeDefined();
  });
});

function scripted(steps: AdapterEvent[][]): StreamFn {
  let index = 0;
  return async function* () {
    const step = steps[Math.min(index, steps.length - 1)] ?? [];
    index += 1;
    for (const event of step) yield event;
  };
}

function workDeps(
  db: Database,
  events: EventLog,
  root: string,
  steps: AdapterEvent[][],
  overrides: Partial<WorkDeps> = {},
): WorkDeps {
  const base: WorkDeps = {
    db,
    events,
    stream: scripted(steps),
    tools: createRegistry(builtinTools({ root })),
    policy: WORK_POLICY,
    scriptsRoot: root,
    limits: {
      firstTokenMs: 5_000,
      idleMs: 5_000,
      toolMs: 2_000,
      maxOutputTokens: 200,
      maxToolRounds: 3,
      totalMs: 30_000,
    },
    maxConcurrent: 2,
  };
  return { ...base, ...overrides };
}

describe("inline execution", () => {
  test("a script job returns its result inside the same call", async () => {
    const { db, events, root } = fresh();
    await Bun.write(
      join(root, "jobs", "count.ts"),
      "console.log(JSON.stringify({ collected: 2 }));\n",
    );
    const deps = workDeps(db, events, root, []);
    const workflow = createWorkflow(
      db,
      {
        title: "수집",
        instruction: "수집한다",
        executor: { kind: "script", path: "jobs/count.ts", args: [] },
      },
      BASE,
      events,
    );
    const result = await runWorkflowInline(deps, { workflowId: workflow.id, triggerKind: "tool" });
    expect(result.status).toBe("succeeded");
    expect(z.object({ text: z.string() }).parse(result.result).text).toContain("collected");
    const stored = getRun(db, result.runId);
    expect(stored?.status).toBe("succeeded");
    expect(stored?.triggerKind).toBe("tool");
    expect(runsForWorkflow(db, workflow.id)).toHaveLength(1);
  });

  test("an approval-seeking tool is refused instead of pausing a run nobody can approve", async () => {
    const { db, events, root } = fresh();
    const deps = workDeps(
      db,
      events,
      root,
      [
        [
          {
            type: "tool_call",
            id: "c1",
            name: "external_action",
            arguments: JSON.stringify({ summary: "전송" }),
          },
          { type: "done", finishReason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "거부되었습니다." },
          { type: "done", finishReason: "stop" },
        ],
      ],
      {
        policy: [
          { action: "*", resource: "*", effect: "deny" },
          { action: "read", resource: "*", effect: "allow" },
          { action: "edit", resource: "*", effect: "allow" },
          { action: "external_action", resource: "*", effect: "ask" },
        ],
      },
    );
    const workflow = createWorkflow(db, agentDefinition(), BASE, events);
    const result = await runWorkflowInline(deps, { workflowId: workflow.id, triggerKind: "tool" });
    expect(result.status).toBe("succeeded");
    expect(count(db, "SELECT count(*) AS n FROM approvals")).toBe(0);
    expect(getRun(db, result.runId)?.status).toBe("succeeded");
  });

  test("the caller's abort stops the inline child and the caller's budget bounds it", async () => {
    const { db, events, root } = fresh();
    await Bun.write(
      join(root, "jobs", "slow.ts"),
      "await Bun.sleep(150);\nconsole.log('늦게 끝남');\n",
    );
    const deps = workDeps(db, events, root, [], {
      limits: {
        firstTokenMs: 5_000,
        idleMs: 5_000,
        toolMs: 2_000,
        maxOutputTokens: 200,
        maxToolRounds: 3,
        totalMs: 60,
      },
    });
    const workflow = createWorkflow(
      db,
      {
        title: "느린 수집",
        instruction: "느리게",
        executor: { kind: "script", path: "jobs/slow.ts", args: [] },
        timeoutSeconds: 60,
      },
      BASE,
      events,
    );
    const result = await runWorkflowInline(deps, {
      workflowId: workflow.id,
      triggerKind: "script",
    });
    expect(result.status).toBe("interrupted");
    expect(getRun(db, result.runId)?.status).toBe("interrupted");
  });
});
