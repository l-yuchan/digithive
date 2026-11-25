import type { Database } from "bun:sqlite";
import type { EventLog } from "../events/log";
import type { ToolRuntime } from "./registry";
import {
  CreateScheduleSchema,
  UpdateScheduleSchema,
  createSchedule,
  deleteSchedule,
  listSchedules,
  runScheduleNow,
  updateSchedule,
} from "../scheduler/schedules";
import { z } from "zod";

export type ScheduleToolDeps = {
  readonly db: Database;
  readonly events: EventLog;
};

const TriggerDescription =
  "once {kind:'once',at:ISO} | interval {kind:'interval',everySeconds:int,anchorAt:ISO} | daily {kind:'daily',time:'HH:mm',timeZone:IANA}";
const ExecutorDescription =
  "{kind:'agent'} | {kind:'builtin',name:'sync_sources'|'briefing',accountId?} | {kind:'script',path,args?}";

/**
 * Conversation-facing schedule management. Read lists definitions; edit only
 * persists definitions or enqueues a manual run. Nothing executes inline.
 */
export function scheduleTools(deps: ScheduleToolDeps): ToolRuntime[] {
  return [
    {
      name: "schedules_list",
      description: "저장된 일정 정의와 마지막 실행 상태를 나열합니다. 실행을 시작하지 않습니다.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      action: "read",
      conversation: true,
      execute: async () => JSON.stringify({ schedules: listSchedules(deps.db) }),
    },
    {
      name: "schedules_edit",
      description: `일정 정의를 만들기·수정하기·삭제하거나 지금 실행을 큐에 넣습니다. trigger: ${TriggerDescription}. executor: ${ExecutorDescription}. create/update/delete는 실행하지 않습니다.`,
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["create", "update", "delete", "run"] },
          id: { type: "string", description: "update/delete/run 대상 일정 id" },
          title: { type: "string" },
          instruction: { type: "string", description: "agent 실행의 목표" },
          enabled: { type: "boolean" },
          trigger: { type: "object", description: TriggerDescription },
          executor: { type: "object", description: ExecutorDescription },
          timeoutSeconds: { type: "integer", minimum: 1, maximum: 86_400 },
        },
        required: ["action"],
        additionalProperties: false,
      },
      action: "edit",
      conversation: true,
      execute: async (raw) => {
        const args = z.record(z.string(), z.unknown()).parse(raw);
        const action = args["action"];
        if (action === "create") {
          const schedule = createSchedule(
            deps.db,
            CreateScheduleSchema.parse({
              title: args["title"],
              instruction: args["instruction"],
              enabled: args["enabled"],
              trigger: args["trigger"],
              executor: args["executor"],
              timeoutSeconds: args["timeoutSeconds"],
            }),
            Date.now(),
            deps.events,
          );
          return JSON.stringify({ schedule });
        }
        const id = typeof args["id"] === "string" ? args["id"] : "";
        if (id.length === 0) throw new Error("schedule_id_required");
        if (action === "update") {
          const patch: Record<string, unknown> = {};
          for (const key of [
            "title",
            "instruction",
            "enabled",
            "trigger",
            "executor",
            "timeoutSeconds",
          ] as const) {
            if (args[key] !== undefined) patch[key] = args[key];
          }
          const parsed = UpdateScheduleSchema.parse(patch);
          const schedule = updateSchedule(deps.db, id, parsed, Date.now(), deps.events);
          if (!schedule) throw new Error("schedule_not_found");
          return JSON.stringify({ schedule });
        }
        if (action === "delete") {
          if (!deleteSchedule(deps.db, id, deps.events)) throw new Error("schedule_not_found");
          return JSON.stringify({ deleted: true, id });
        }
        if (action === "run") {
          const queued = runScheduleNow(deps, id);
          if (!queued) throw new Error("schedule_not_found");
          return JSON.stringify({
            run: queued.run,
            occurrence: { scheduledFor: queued.scheduledFor, manual: true },
          });
        }
        throw new Error("invalid_action");
      },
    },
  ];
}
