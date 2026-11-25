import type { Database } from "bun:sqlite";
import type { EventLog } from "../events/log";
import type { ToolRuntime } from "./registry";
import {
  CreateScheduleBindingSchema,
  UpdateScheduleBindingSchema,
} from "../workflows/workflow-types";
import { WorkflowError } from "../workflows/workflow-store";
import {
  bindingRuns,
  createBinding,
  deleteBinding,
  getBinding,
  listBindingViews,
  updateBinding,
} from "../scheduler/schedule-store";
import { z } from "zod";

export type ScheduleToolDeps = {
  readonly db: Database;
  readonly events: EventLog;
};

const TriggerDescription =
  "once {kind:'once',at:ISO} | interval {kind:'interval',everySeconds:int,anchorAt:ISO} | daily {kind:'daily',time:'HH:mm',timeZone:IANA}";

function failure(error: unknown): string {
  if (error instanceof WorkflowError) {
    return JSON.stringify({ error: error.code, detail: error.detail });
  }
  throw error;
}

/**
 * A schedule only decides *when* a workflow runs. Editing one never changes the
 * definition, and nothing here starts a run.
 */
export function scheduleTools(deps: ScheduleToolDeps): ToolRuntime[] {
  return [
    {
      name: "schedule_list",
      description:
        "스케줄(워크플로의 자동 실행) 목록입니다. workflowId를 주면 그 정의에 걸린 것만 봅니다. trigger: " +
        TriggerDescription,
      parameters: {
        type: "object",
        properties: { workflowId: { type: "string" } },
        additionalProperties: false,
      },
      action: "read",
      conversation: true,
      execute: async (raw) => {
        const input = z.object({ workflowId: z.string().min(1).optional() }).parse(raw);
        return JSON.stringify({ schedules: listBindingViews(deps.db, input.workflowId) });
      },
    },
    {
      name: "schedule_detail",
      description: "스케줄 하나와 최근 실행 기록입니다.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      action: "read",
      conversation: true,
      execute: async (raw) => {
        const { id } = z.object({ id: z.string().min(1) }).parse(raw);
        const binding = getBinding(deps.db, id);
        if (!binding) return failure(new WorkflowError("schedule_not_found"));
        const runs = (bindingRuns(deps.db, id) ?? []).slice(0, 5).map((run) => ({
          id: run.id,
          status: run.status,
          scheduledFor: run.scheduledFor,
          manual: run.manual,
          settledAt: run.settledAt,
          resultJson: run.resultJson === null ? null : run.resultJson.slice(0, 2_000),
        }));
        return JSON.stringify({ schedule: binding, runs });
      },
    },
    {
      name: "schedule_create",
      description:
        "워크플로에 자동 실행을 추가합니다. args는 정의가 선언한 파라미터 값이며, 무효하면 저장되지 않습니다. trigger: " +
        TriggerDescription,
      parameters: {
        type: "object",
        properties: {
          workflowId: { type: "string" },
          trigger: { type: "object", description: TriggerDescription },
          enabled: { type: "boolean" },
          args: { type: "object" },
        },
        required: ["workflowId", "trigger"],
        additionalProperties: false,
      },
      action: "edit",
      conversation: true,
      execute: async (raw) => {
        try {
          const schedule = createBinding(
            deps.db,
            CreateScheduleBindingSchema.parse(raw),
            Date.now(),
            deps.events,
          );
          return JSON.stringify({ schedule });
        } catch (error) {
          return failure(error);
        }
      },
    },
    {
      name: "schedule_edit",
      description: "스케줄의 반복·사용 여부·파라미터 값을 수정합니다. 정의는 바꾸지 않습니다.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          delta: { type: "object", description: "trigger?, enabled?, args?" },
        },
        required: ["id", "delta"],
        additionalProperties: false,
      },
      action: "edit",
      conversation: true,
      execute: async (raw) => {
        try {
          const input = z
            .object({ id: z.string().min(1), delta: z.record(z.string(), z.unknown()) })
            .parse(raw);
          const schedule = updateBinding(
            deps.db,
            input.id,
            UpdateScheduleBindingSchema.parse(input.delta),
            Date.now(),
            deps.events,
          );
          if (!schedule) return failure(new WorkflowError("schedule_not_found"));
          return JSON.stringify({ schedule });
        } catch (error) {
          return failure(error);
        }
      },
    },
    {
      name: "schedule_delete",
      description: "스케줄을 삭제합니다. 워크플로 정의와 실행 기록은 남습니다.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      action: "edit",
      conversation: true,
      execute: async (raw) => {
        const { id } = z.object({ id: z.string().min(1) }).parse(raw);
        if (!deleteBinding(deps.db, id, deps.events))
          return failure(new WorkflowError("schedule_not_found"));
        return JSON.stringify({ deleted: true, id });
      },
    },
  ];
}
