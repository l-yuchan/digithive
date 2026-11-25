import {
  ScheduleInputSchema,
  type Executor,
  type Schedule,
  type ScheduleInput,
  type Trigger,
} from "./scheduleTypes";

export type ScheduleDraft = {
  readonly title: string;
  readonly instruction: string;
  readonly enabled: boolean;
  readonly triggerKind: Trigger["kind"];
  readonly onceAt: string;
  readonly everySeconds: string;
  readonly anchorAt: string;
  readonly dailyTime: string;
  readonly timeZone: string;
  readonly executorKind: Executor["kind"];
  readonly builtinName: "sync_sources" | "briefing";
  readonly accountId: string;
  readonly scriptPath: string;
  readonly scriptArgs: string;
  readonly timeoutSeconds: string;
};

function toDateTimeInput(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function fromTrigger(
  trigger: Trigger,
): Pick<ScheduleDraft, "onceAt" | "everySeconds" | "anchorAt" | "dailyTime" | "timeZone"> {
  return {
    onceAt: toDateTimeInput(
      trigger.kind === "once" ? trigger.at : new Date(Date.now() + 3_600_000).toISOString(),
    ),
    everySeconds: trigger.kind === "interval" ? String(trigger.everySeconds) : "900",
    anchorAt: toDateTimeInput(
      trigger.kind === "interval" ? trigger.anchorAt : new Date().toISOString(),
    ),
    dailyTime: trigger.kind === "daily" ? trigger.time : "07:30",
    timeZone: trigger.kind === "daily" ? trigger.timeZone : "Asia/Seoul",
  };
}

function fromExecutor(
  executor: Executor,
): Pick<ScheduleDraft, "builtinName" | "accountId" | "scriptPath" | "scriptArgs"> {
  return {
    builtinName: executor.kind === "builtin" ? executor.name : "sync_sources",
    accountId: executor.kind === "builtin" ? (executor.accountId ?? "") : "",
    scriptPath: executor.kind === "script" ? executor.path : "",
    scriptArgs: executor.kind === "script" ? executor.args.join("\n") : "",
  };
}

export function createDraft(schedule: Schedule | null): ScheduleDraft {
  const now = new Date();
  return {
    title: schedule?.title ?? "",
    instruction: schedule?.instruction ?? "",
    enabled: schedule?.enabled ?? true,
    triggerKind: schedule?.trigger.kind ?? "daily",
    ...(schedule
      ? fromTrigger(schedule.trigger)
      : {
          onceAt: toDateTimeInput(new Date(now.getTime() + 3_600_000).toISOString()),
          everySeconds: "900",
          anchorAt: toDateTimeInput(now.toISOString()),
          dailyTime: "07:30",
          timeZone: "Asia/Seoul",
        }),
    executorKind: schedule?.executor.kind ?? "agent",
    ...(schedule
      ? fromExecutor(schedule.executor)
      : {
          builtinName: "sync_sources" as const,
          accountId: "",
          scriptPath: "",
          scriptArgs: "",
        }),
    timeoutSeconds: String(schedule?.timeoutSeconds ?? 1800),
  };
}

function required(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${label}을(를) 입력하세요.`);
  return trimmed;
}

function isoDateTime(value: string, label: string): string {
  const date = new Date(required(value, label));
  if (Number.isNaN(date.getTime())) throw new Error(`${label}이(가) 올바르지 않습니다.`);
  return date.toISOString();
}

function positiveInteger(value: string, label: string, maximum: number): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > maximum)
    throw new Error(`${label}은(는) 1부터 ${maximum} 사이의 정수여야 합니다.`);
  return number;
}

function scriptPath(value: string): string {
  const path = required(value, "스크립트 경로");
  if (path.length > 500) throw new Error("스크립트 경로는 500자 이하여야 합니다.");
  if (/\s/.test(path))
    throw new Error(
      "경로에 공백이나 셸 명령어를 넣을 수 없습니다. 인자는 아래 칸에 줄당 하나씩 입력하세요.",
    );
  if (/[;&|$<>`'"\\]/.test(path) || path.includes(":") || path.startsWith("/"))
    throw new Error("서버 scripts 디렉터리 기준의 상대 파일 경로만 입력하세요.");
  if (path.split("/").some((part) => part.length === 0 || part === ".."))
    throw new Error("상위 디렉터리로 이동하지 않는 올바른 상대 경로를 입력하세요.");
  if (!/\.(ts|js)$/.test(path)) throw new Error("스크립트 경로는 .ts 또는 .js 파일이어야 합니다.");
  return path;
}

function makeTrigger(draft: ScheduleDraft): Trigger {
  switch (draft.triggerKind) {
    case "once":
      return { kind: "once", at: isoDateTime(draft.onceAt, "실행 시각") };
    case "interval":
      return {
        kind: "interval",
        everySeconds: positiveInteger(draft.everySeconds, "실행 간격(초)", Number.MAX_SAFE_INTEGER),
        anchorAt: isoDateTime(draft.anchorAt, "간격 기준 시각"),
      };
    case "daily": {
      const timeZone = required(draft.timeZone, "시간대");
      try {
        new Intl.DateTimeFormat("ko-KR", { timeZone }).format();
      } catch {
        throw new Error("Asia/Seoul 같은 올바른 IANA 시간대를 입력하세요.");
      }
      return { kind: "daily", time: draft.dailyTime, timeZone };
    }
    default:
      throw new Error("알 수 없는 반복 방식입니다.");
  }
}

function makeExecutor(draft: ScheduleDraft): Executor {
  switch (draft.executorKind) {
    case "agent":
      return { kind: "agent" };
    case "builtin":
      return {
        kind: "builtin",
        name: draft.builtinName,
        ...(draft.accountId ? { accountId: draft.accountId } : {}),
      };
    case "script":
      return {
        kind: "script",
        path: scriptPath(draft.scriptPath),
        args: draft.scriptArgs.split(/\r?\n/).filter((line) => line.length > 0),
      };
    default:
      throw new Error("알 수 없는 실행 방식입니다.");
  }
}

export function draftToInput(draft: ScheduleDraft): ScheduleInput {
  return ScheduleInputSchema.parse({
    title: required(draft.title, "제목"),
    instruction: required(draft.instruction, "실행 지시"),
    enabled: draft.enabled,
    trigger: makeTrigger(draft),
    executor: makeExecutor(draft),
    timeoutSeconds: positiveInteger(draft.timeoutSeconds, "제한 시간(초)", 86400),
  });
}
