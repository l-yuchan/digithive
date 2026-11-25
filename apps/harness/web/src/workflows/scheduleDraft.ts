import {
  createArgsDraft,
  defaultWorkflowArgs,
  argsDraftToRecord,
  type ArgsDraft,
} from "./argsDraft";
import type { ScheduleBinding, Trigger, WorkflowParam } from "./workflowTypes";

export type ScheduleDraft = {
  readonly triggerKind: Trigger["kind"];
  readonly onceAt: string;
  readonly everySeconds: string;
  readonly anchorAt: string;
  readonly dailyTime: string;
  readonly timeZone: string;
  readonly enabled: boolean;
  readonly args: ArgsDraft;
};

function toDateTimeInput(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function createScheduleDraft(
  params: readonly WorkflowParam[],
  schedule: ScheduleBinding | null,
): ScheduleDraft {
  const now = new Date();
  const trigger = schedule?.trigger;
  return {
    triggerKind: trigger?.kind ?? "daily",
    onceAt: toDateTimeInput(
      trigger?.kind === "once" ? trigger.at : new Date(now.getTime() + 3_600_000).toISOString(),
    ),
    everySeconds: trigger?.kind === "interval" ? String(trigger.everySeconds) : "900",
    anchorAt: toDateTimeInput(trigger?.kind === "interval" ? trigger.anchorAt : now.toISOString()),
    dailyTime: trigger?.kind === "daily" ? trigger.time : "07:30",
    timeZone: trigger?.kind === "daily" ? trigger.timeZone : "Asia/Seoul",
    enabled: schedule?.enabled ?? true,
    args: createArgsDraft(params, schedule?.args ?? defaultWorkflowArgs(params)),
  };
}

function required(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label}을(를) 입력하세요.`);
  return trimmed;
}

function isoDateTime(value: string, label: string): string {
  const date = new Date(required(value, label));
  if (Number.isNaN(date.getTime())) throw new Error(`${label}이(가) 올바르지 않습니다.`);
  return date.toISOString();
}

export function makeTrigger(draft: ScheduleDraft): Trigger {
  if (draft.triggerKind === "once") {
    return { kind: "once", at: isoDateTime(draft.onceAt, "실행 시각") };
  }
  if (draft.triggerKind === "interval") {
    const everySeconds = Number(draft.everySeconds);
    if (!Number.isInteger(everySeconds) || everySeconds < 1) {
      throw new Error("실행 간격은 1초 이상의 정수여야 합니다.");
    }
    return {
      kind: "interval",
      everySeconds,
      anchorAt: isoDateTime(draft.anchorAt, "간격 기준 시각"),
    };
  }
  const timeZone = required(draft.timeZone, "시간대");
  try {
    new Intl.DateTimeFormat("ko-KR", { timeZone }).format();
  } catch {
    throw new Error("Asia/Seoul 같은 올바른 IANA 시간대를 입력하세요.");
  }
  return { kind: "daily", time: draft.dailyTime, timeZone };
}

export function scheduleDraftToInput(
  draft: ScheduleDraft,
  params: readonly WorkflowParam[],
): {
  readonly trigger: Trigger;
  readonly enabled: boolean;
  readonly args: Readonly<Record<string, unknown>>;
} {
  return {
    trigger: makeTrigger(draft),
    enabled: draft.enabled,
    args: argsDraftToRecord(draft.args, params),
  };
}
