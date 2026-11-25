import {
  MAX_WORKFLOW_PARAMS,
  PARAM_NAME_PATTERN,
  WorkflowParamsSchema,
  valueMatchesParamType,
  type Executor,
  type SourceName,
  type Workflow,
  type WorkflowParam,
  type WorkflowParamType,
  type CapabilityGroup,
} from "./workflowTypes";

export type ParamDraft = {
  readonly name: string;
  readonly type: WorkflowParamType;
  readonly required: boolean;
  readonly defaultText: string;
  readonly description: string;
};

export type WorkflowDraft = {
  readonly title: string;
  readonly instruction: string;
  readonly timeoutSeconds: string;
  readonly executorKind: Executor["kind"];
  readonly builtinName: "sync_sources" | "briefing";
  readonly accountId: string;
  readonly sources: readonly SourceName[];
  readonly scriptPath: string;
  readonly scriptArgs: string;
  readonly capabilities: readonly CapabilityGroup[];
  readonly params: readonly ParamDraft[];
};

export type WorkflowInput = {
  readonly title: string;
  readonly instruction: string;
  readonly executor: Executor;
  readonly params: readonly WorkflowParam[];
  readonly timeoutSeconds: number;
};

export function emptyParamDraft(): ParamDraft {
  return { name: "", type: "string", required: false, defaultText: "", description: "" };
}

export function createWorkflowDraft(workflow: Workflow | null): WorkflowDraft {
  const executor = workflow?.executor;
  return {
    title: workflow?.title ?? "",
    instruction: workflow?.instruction ?? "",
    timeoutSeconds: String(workflow?.timeoutSeconds ?? 1_800),
    executorKind: executor?.kind ?? "agent",
    builtinName: executor?.kind === "builtin" ? executor.name : "sync_sources",
    accountId: executor?.kind === "builtin" ? (executor.accountId ?? "") : "",
    sources:
      executor?.kind === "builtin" && executor.name === "sync_sources"
        ? (executor.sources ?? [])
        : [],
    scriptPath: executor?.kind === "script" ? executor.path : "",
    scriptArgs: executor?.kind === "script" ? executor.args.join("\n") : "",
    capabilities: executor?.kind === "script" ? (executor.capabilities ?? []) : [],
    params: (workflow?.params ?? []).map((param) => ({
      name: param.name,
      type: param.type,
      required: param.required,
      defaultText: param.default === undefined ? "" : JSON.stringify(param.default),
      description: param.description ?? "",
    })),
  };
}

function required(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label}을(를) 입력하세요.`);
  return trimmed;
}

function positiveInteger(value: string, label: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 86_400) {
    throw new Error(`${label}은(는) 1부터 86400 사이의 정수여야 합니다.`);
  }
  return number;
}

function scriptPath(value: string): string {
  const path = required(value, "스크립트 경로");
  if (path.length > 500) throw new Error("스크립트 경로는 500자 이하여야 합니다.");
  if (/\s/.test(path))
    throw new Error("경로에 공백을 넣을 수 없습니다. 인자는 줄당 하나씩 입력하세요.");
  if (/[;&|$<>`'"\\]/.test(path) || path.includes(":") || path.startsWith("/")) {
    throw new Error("서버 scripts 디렉터리 기준의 상대 파일 경로만 입력하세요.");
  }
  if (path.split("/").some((part) => !part || part === "..")) {
    throw new Error("상위 디렉터리로 이동하지 않는 올바른 상대 경로를 입력하세요.");
  }
  if (!/\.(ts|js)$/.test(path)) throw new Error("스크립트 경로는 .ts 또는 .js 파일이어야 합니다.");
  return path;
}

function makeExecutor(draft: WorkflowDraft): Executor {
  if (draft.executorKind === "agent") return { kind: "agent" };
  if (draft.executorKind === "script") {
    return {
      kind: "script",
      path: scriptPath(draft.scriptPath),
      args: draft.scriptArgs.split(/\r?\n/).filter((line) => line.length > 0),
      capabilities: [...draft.capabilities],
    };
  }
  if (draft.builtinName === "sync_sources") {
    if (!draft.accountId) throw new Error("수집할 계정을 선택하세요.");
    if (draft.sources.length === 0) throw new Error("수집할 정보를 하나 이상 선택하세요.");
    return {
      kind: "builtin",
      name: "sync_sources",
      accountId: draft.accountId,
      sources: [...draft.sources],
    };
  }
  return {
    kind: "builtin",
    name: "briefing",
    ...(draft.accountId ? { accountId: draft.accountId } : {}),
  };
}

function parseParams(rows: readonly ParamDraft[]): readonly WorkflowParam[] {
  if (rows.length > MAX_WORKFLOW_PARAMS)
    throw new Error("파라미터는 최대 16개까지 추가할 수 있습니다.");
  const names = new Set<string>();
  const params = rows.map((row, index) => {
    const name = required(row.name, `파라미터 ${index + 1} 이름`);
    if (!PARAM_NAME_PATTERN.test(name)) {
      throw new Error(
        `${name}: 영문자로 시작하고 영문자·숫자·밑줄만 사용하는 1~32자 이름이어야 합니다.`,
      );
    }
    if (names.has(name)) throw new Error(`파라미터 이름이 중복되었습니다: ${name}`);
    names.add(name);
    let defaultValue: unknown;
    if (row.defaultText.trim()) {
      try {
        defaultValue = JSON.parse(row.defaultText) as unknown;
      } catch {
        throw new Error(`${name} 기본값은 올바른 JSON이어야 합니다. 문자열은 "값"처럼 입력하세요.`);
      }
      if (!valueMatchesParamType(row.type, defaultValue)) {
        throw new Error(`${name} 기본값이 ${row.type} 타입과 맞지 않습니다.`);
      }
    }
    if (row.description.length > 200) throw new Error(`${name} 설명은 200자 이하여야 합니다.`);
    return {
      name,
      type: row.type,
      required: row.required,
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
      ...(row.description.trim() ? { description: row.description.trim() } : {}),
    };
  });
  return WorkflowParamsSchema.parse(params);
}

export function workflowDraftToInput(draft: WorkflowDraft): WorkflowInput {
  return {
    title: required(draft.title, "제목"),
    instruction: required(draft.instruction, "실행 지시"),
    executor: makeExecutor(draft),
    params: parseParams(draft.params),
    timeoutSeconds: positiveInteger(draft.timeoutSeconds, "제한 시간(초)"),
  };
}
