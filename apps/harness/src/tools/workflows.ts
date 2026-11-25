import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { EventLog } from "../events/log";
import type { ToolRuntime } from "./registry";
import type { WorkDeps } from "../surfaces/work/runner";
import { runWorkflowInline } from "../surfaces/work/inline-run";
import {
  CreateWorkflowSchema,
  RunWorkflowInputSchema,
  WORKFLOW_DETAIL_SECTIONS,
  WorkflowDetailQuerySchema,
  WorkflowSearchSchema,
  type WorkflowView,
} from "../workflows/workflow-types";
import {
  WorkflowError,
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  runsForWorkflow,
  updateWorkflow,
  workflowView,
} from "../workflows/workflow-store";
import { searchWorkflowIds } from "../workflows/workflow-search";
import { enqueueWorkflowRun } from "../workflows/workflow-run";

export type WorkflowToolDeps = {
  readonly db: Database;
  readonly events: EventLog;
  /** Resolved lazily: the registry that owns these tools lives inside WorkDeps. */
  readonly work: () => WorkDeps;
};

const TriggerDescription =
  "once {kind:'once',at:ISO} | interval {kind:'interval',everySeconds:int,anchorAt:ISO} | daily {kind:'daily',time:'HH:mm',timeZone:IANA}";
const ExecutorDescription =
  "{kind:'agent'} | {kind:'builtin',name:'sync_sources'|'briefing',accountId?} | {kind:'script',path,args?,capabilities?}";

function failure(error: unknown): string {
  if (error instanceof WorkflowError) {
    return JSON.stringify({ error: error.code, detail: error.detail });
  }
  throw error;
}

function compact(workflow: WorkflowView): Record<string, unknown> {
  const enabled = workflow.schedules.filter((binding) => binding.enabled);
  const next = enabled
    .map((binding) => binding.nextRunAt)
    .filter((value): value is string => value !== null)
    .toSorted()[0];
  return {
    id: workflow.id,
    title: workflow.title,
    executorKind: workflow.executor.kind,
    paramCount: workflow.params.length,
    schedules: {
      count: workflow.schedules.length,
      enabled: enabled.length,
      nextRunAt: next ?? null,
    },
    lastRun: workflow.lastRun
      ? { status: workflow.lastRun.status, settledAt: workflow.lastRun.settledAt }
      : null,
    updatedAt: workflow.updatedAt,
  };
}

/**
 * Deferred loading: search returns compact identities, detail returns the
 * sections asked for, and run is the only tool that executes anything.
 */
export function workflowTools(deps: WorkflowToolDeps): ToolRuntime[] {
  return [
    {
      name: "workflow_list",
      description: `워크플로 정의를 검색합니다. keyword(모든 단어 포함) · regex(정규식) · bm25(FTS5 trigram, 3자 이상) 중 하나만 지정하거나 아무것도 지정하지 않아 전체를 봅니다. 상세는 workflow_detail로 확인하세요.`,
      parameters: {
        type: "object",
        properties: {
          keyword: { type: "string" },
          regex: { type: "string" },
          bm25: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
        additionalProperties: false,
      },
      action: "read",
      conversation: true,
      execute: async (raw) => {
        try {
          const input = WorkflowSearchSchema.parse(raw);
          const hits = searchWorkflowIds(deps.db, input);
          const workflows: Record<string, unknown>[] = [];
          for (const hit of hits) {
            const view = workflowView(deps.db, hit.id);
            if (!view) continue;
            workflows.push(
              hit.score === null ? compact(view) : { ...compact(view), score: hit.score },
            );
          }
          return JSON.stringify({ workflows });
        } catch (error) {
          return failure(error);
        }
      },
    },
    {
      name: "workflow_detail",
      description: `워크플로 하나의 상세입니다. filter로 필요한 섹션만 받으세요: ${WORKFLOW_DETAIL_SECTIONS.join(", ")}. 기본값은 정의·파라미터·실행기·스케줄입니다. runs를 요청하면 최근 실행 10건의 상태·파라미터·결과를 함께 돌려줍니다.`,
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          filter: {
            type: "array",
            items: { type: "string", enum: [...WORKFLOW_DETAIL_SECTIONS] },
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
      action: "read",
      conversation: true,
      execute: async (raw) => {
        try {
          const input = WorkflowDetailQuerySchema.parse(raw);
          const workflow = getWorkflow(deps.db, input.id);
          if (!workflow) return failure(new WorkflowError("workflow_not_found"));
          const sections = input.filter ?? ["definition", "params", "executor", "schedules"];
          const body: Record<string, unknown> = { id: workflow.id };
          if (sections.includes("definition"))
            body["definition"] = {
              title: workflow.title,
              instruction: workflow.instruction,
              timeoutSeconds: workflow.timeoutSeconds,
              createdAt: workflow.createdAt,
              updatedAt: workflow.updatedAt,
            };
          if (sections.includes("params")) body["params"] = workflow.params;
          if (sections.includes("executor")) body["executor"] = workflow.executor;
          if (sections.includes("caps"))
            body["capabilities"] =
              workflow.executor.kind === "script" ? (workflow.executor.capabilities ?? []) : [];
          if (sections.includes("schedules"))
            body["schedules"] = workflowView(deps.db, workflow.id)?.schedules ?? [];
          if (sections.includes("runs"))
            body["runs"] = runsForWorkflow(deps.db, workflow.id, 10).map((run) => ({
              ...run,
              resultJson: run.resultJson === null ? null : run.resultJson.slice(0, 2_000),
            }));
          return JSON.stringify(body);
        } catch (error) {
          return failure(error);
        }
      },
    },
    {
      name: "workflow_create",
      description: `워크플로 정의를 만듭니다. trigger는 없습니다(자동 실행은 스케줄입니다). trigger: ${TriggerDescription}. executor: ${ExecutorDescription}.`,
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          instruction: { type: "string" },
          executor: { type: "object", description: ExecutorDescription },
          params: {
            type: "array",
            description:
              "[{name,type:'string'|'number'|'boolean'|'json',required?,default?,description?}]",
          },
          timeoutSeconds: { type: "integer", minimum: 1, maximum: 86_400 },
        },
        required: ["title", "instruction", "executor"],
        additionalProperties: false,
      },
      action: "edit",
      conversation: true,
      execute: async (raw) => {
        try {
          const workflow = createWorkflow(
            deps.db,
            CreateWorkflowSchema.parse(raw),
            Date.now(),
            deps.events,
          );
          return JSON.stringify({ workflow });
        } catch (error) {
          return failure(error);
        }
      },
    },
    {
      name: "workflow_edit",
      description:
        "워크플로 정의를 부분 수정합니다. delta에 바꿀 필드만 넣으세요(제목·지시·실행기·파라미터·제한 시간). 파라미터 변경으로 기존 스케줄 값이 무효가 되면 실행되지 않고 어떤 스케줄이 왜 깨지는지 돌려줍니다.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          delta: { type: "object" },
          force: { type: "boolean", description: "무효가 된 스케줄 값은 버리고 저장" },
        },
        required: ["id", "delta"],
        additionalProperties: false,
      },
      action: "edit",
      conversation: true,
      execute: async (raw) => {
        try {
          const input = z
            .object({
              id: z.string().min(1),
              delta: z.record(z.string(), z.unknown()),
              force: z.boolean().optional(),
            })
            .parse(raw);
          const result = updateWorkflow(deps.db, input.id, input.delta, {
            events: deps.events,
            force: input.force === true,
          });
          return JSON.stringify(result);
        } catch (error) {
          return failure(error);
        }
      },
    },
    {
      name: "workflow_delete",
      description:
        "워크플로 정의를 삭제합니다. 스케줄이 걸려 있으면 cascade 없이는 거부합니다. 실행 기록은 남습니다.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" }, cascade: { type: "boolean" } },
        required: ["id"],
        additionalProperties: false,
      },
      action: "edit",
      conversation: true,
      execute: async (raw) => {
        try {
          const input = z
            .object({ id: z.string().min(1), cascade: z.boolean().optional() })
            .parse(raw);
          const removed = deleteWorkflow(deps.db, input.id, {
            cascade: input.cascade === true,
            events: deps.events,
          });
          return JSON.stringify({ deleted: true, id: input.id, ...removed });
        } catch (error) {
          return failure(error);
        }
      },
    },
    {
      name: "workflow_run",
      description:
        "워크플로를 지금 실행합니다. 기본은 이 호출 안에서 끝까지 실행하고 결과를 돌려줍니다(자식 실행은 호출자의 남은 시간·중첩 깊이 3 안에서 돕니다). 오래 걸리는 작업은 async:true로 큐에 넘기고 runId만 받으세요. 승인이 필요한 도구는 인라인에서 거부됩니다.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          args: { type: "object", description: "정의가 선언한 파라미터 값" },
          async: { type: "boolean" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      action: "edit",
      conversation: true,
      selfDeadline: true,
      execute: async (raw, context) => {
        try {
          const input = RunWorkflowInputSchema.parse(raw);
          if (input.async) {
            const prepared = enqueueWorkflowRun(deps, input.id, {
              args: input.args,
              triggerKind: "tool",
              parentRunId: context.runId,
            });
            return JSON.stringify({
              runId: prepared.run.id,
              status: prepared.run.status,
              workflow: { id: prepared.workflow.id, title: prepared.workflow.title },
              params: prepared.params,
              hint: "결과는 workflow_detail(id, ['runs']) 또는 실행 기록 화면에서 확인하세요.",
            });
          }
          const result = await runWorkflowInline(deps.work(), {
            workflowId: input.id,
            args: input.args,
            triggerKind: "tool",
            parentRunId: context.runId,
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          });
          return JSON.stringify(result);
        } catch (error) {
          return failure(error);
        }
      },
    },
  ];
}

export function workflowToolNames(): string[] {
  return [
    "workflow_list",
    "workflow_detail",
    "workflow_create",
    "workflow_edit",
    "workflow_delete",
    "workflow_run",
  ];
}
