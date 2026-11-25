import { describe, expect, test } from "bun:test";
import {
  CreateScheduleBindingSchema,
  CreateWorkflowSchema,
  RunWorkflowInputSchema,
  UpdateWorkflowSchema,
  WorkflowParamsSchema,
  WorkflowSearchSchema,
  rowToWorkflow,
  valueMatchesParamType,
} from "../src/workflows/workflow-types";
import { CAPABILITY_GROUPS, RunExecutorSchema } from "../src/core/executor";
import { EVENT_KINDS } from "../src/events/log";

const agent = { kind: "agent" as const };

function issuesOf(result: {
  success: boolean;
  error?: { issues: { message: string }[] };
}): string[] {
  return result.success ? [] : (result.error?.issues ?? []).map((issue) => issue.message);
}

describe("workflow definition contract", () => {
  test("creating a definition applies the documented defaults", () => {
    const parsed = CreateWorkflowSchema.parse({
      title: "정리",
      instruction: "정리한다",
      executor: agent,
    });
    expect(parsed.params).toEqual([]);
    expect(parsed.timeoutSeconds).toBe(1_800);
  });

  test("a patch never resets fields it does not carry", () => {
    const patch = UpdateWorkflowSchema.parse({ title: "새 이름" });
    expect(Object.keys(patch)).toEqual(["title"]);
    expect(patch.params).toBeUndefined();
    expect(patch.timeoutSeconds).toBeUndefined();
  });

  test("a script executor carries no capability until one is granted", () => {
    const parsed = RunExecutorSchema.parse({ kind: "script", path: "jobs/report.ts" });
    expect(parsed).toEqual({ kind: "script", path: "jobs/report.ts", args: [] });
    const granted = RunExecutorSchema.parse({
      kind: "script",
      path: "jobs/report.ts",
      capabilities: ["mail.read", "workflow.run"],
    });
    expect(granted.kind === "script" && granted.capabilities).toEqual([
      "mail.read",
      "workflow.run",
    ]);
    expect(
      RunExecutorSchema.safeParse({ kind: "script", path: "x.ts", capabilities: ["root"] }).success,
    ).toBe(false);
    expect(CAPABILITY_GROUPS).toHaveLength(8);
  });

  test("parameter declarations reject duplicate, malformed and mistyped entries", () => {
    expect(
      issuesOf(
        WorkflowParamsSchema.safeParse([
          { name: "account", type: "string" },
          { name: "account", type: "string" },
        ]),
      ),
    ).toContain("duplicate_param:account");
    expect(issuesOf(WorkflowParamsSchema.safeParse([{ name: "1bad", type: "string" }]))).toContain(
      "invalid_param_name",
    );
    expect(
      issuesOf(WorkflowParamsSchema.safeParse([{ name: "count", type: "number", default: "3" }])),
    ).toContain("invalid_param_default:count");
    expect(
      WorkflowParamsSchema.safeParse([{ name: "count", type: "number", default: 3 }]).success,
    ).toBe(true);
    const many = Array.from({ length: 17 }, (_, index) => ({
      name: `p${index + 1}`,
      type: "string" as const,
    }));
    expect(issuesOf(WorkflowParamsSchema.safeParse(many))).toContain("too_many_params");
  });

  test("value typing is shared with the future resolver", () => {
    expect(valueMatchesParamType("string", "값")).toBe(true);
    expect(valueMatchesParamType("string", 1)).toBe(false);
    expect(valueMatchesParamType("number", Number.NaN)).toBe(false);
    expect(valueMatchesParamType("boolean", false)).toBe(true);
    expect(valueMatchesParamType("json", { a: [1, 2] })).toBe(true);
    expect(valueMatchesParamType("json", undefined)).toBe(false);
  });

  test("a migrated row without capabilities or params still reads as a definition", () => {
    const workflow = rowToWorkflow({
      id: "wf-system-briefing-morning",
      title: "아침 브리핑",
      instruction: "브리핑을 만든다",
      executor_json: '{"kind":"script","path":"jobs/briefing.ts","args":[]}',
      params_json: "[]",
      timeout_seconds: 900,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    expect(workflow.executor.kind).toBe("script");
    expect(workflow.executor.kind === "script" && workflow.executor.capabilities).toBeUndefined();
    expect(workflow.params).toEqual([]);
    expect(workflow.timeoutSeconds).toBe(900);
  });
});

describe("run and search contract", () => {
  test("workflow_run is immediate unless async is requested", () => {
    expect(RunWorkflowInputSchema.parse({ id: "w1" })).toEqual({
      id: "w1",
      args: {},
      async: false,
    });
    expect(RunWorkflowInputSchema.parse({ id: "w1", async: true }).async).toBe(true);
  });

  test("one search mode at a time", () => {
    expect(WorkflowSearchSchema.parse({ keyword: "수집" }).limit).toBe(20);
    expect(issuesOf(WorkflowSearchSchema.safeParse({ keyword: "수집", bm25: "수집" }))).toContain(
      "search_mode_conflict",
    );
  });

  test("a binding names its workflow and defaults to enabled with no args", () => {
    const binding = CreateScheduleBindingSchema.parse({
      workflowId: "wf-1",
      trigger: { kind: "daily", time: "07:30", timeZone: "Asia/Seoul" },
    });
    expect(binding.enabled).toBe(true);
    expect(binding.args).toEqual({});
    expect(
      CreateScheduleBindingSchema.safeParse({
        trigger: { kind: "once", at: "2026-01-01T00:00:00Z" },
      }).success,
    ).toBe(false);
  });
});

describe("event kinds", () => {
  test("workflow events exist and the pre-v10 schedule events stay readable", () => {
    const kinds: ReadonlySet<string> = new Set(EVENT_KINDS);
    for (const kind of [
      "workflow.created",
      "workflow.updated",
      "workflow.deleted",
      "workflow.run",
    ]) {
      expect(kinds.has(kind)).toBe(true);
    }
    for (const legacy of [
      "schedule.created",
      "schedule.updated",
      "schedule.deleted",
      "schedule.run",
    ]) {
      expect(kinds.has(legacy)).toBe(true);
    }
    expect(kinds.has("sdk.capability")).toBe(true);
  });
});
