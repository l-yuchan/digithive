import { z } from "zod";
import { valueMatchesParamType, type WorkflowParam, type WorkflowParamType } from "./workflowTypes";

export type ArgsDraft = {
  readonly mode: "fields" | "json";
  readonly values: Readonly<Record<string, string>>;
  readonly json: string;
};

const has = (record: Readonly<Record<string, unknown>>, key: string) =>
  Object.prototype.hasOwnProperty.call(record, key);

function encodeValue(type: WorkflowParamType, value: unknown): string {
  if (type === "string") return typeof value === "string" ? value : String(value);
  if (type === "number" || type === "boolean") return String(value);
  return JSON.stringify(value, null, 2) ?? "null";
}

export function defaultWorkflowArgs(
  params: readonly WorkflowParam[],
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    params
      .filter((param) => param.default !== undefined)
      .map((param) => [param.name, param.default]),
  );
}

export function createArgsDraft(
  params: readonly WorkflowParam[],
  args: Readonly<Record<string, unknown>>,
): ArgsDraft {
  const values = Object.fromEntries(
    params
      .filter((param) => has(args, param.name))
      .map((param) => [param.name, encodeValue(param.type, args[param.name])]),
  );
  return { mode: "fields", values, json: JSON.stringify(args, null, 2) };
}

function readJsonObject(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("인자는 올바른 JSON 객체여야 합니다.");
  }
  const result = z.record(z.string(), z.unknown()).safeParse(parsed);
  if (!result.success) throw new Error("인자 JSON의 최상위 값은 객체여야 합니다.");
  return result.data;
}

function validateArgs(
  params: readonly WorkflowParam[],
  args: Readonly<Record<string, unknown>>,
): void {
  const declared = new Map(params.map((param) => [param.name, param]));
  const errors: string[] = [];
  for (const key of Object.keys(args)) {
    if (!declared.has(key)) errors.push(`선언되지 않은 인자: ${key}`);
  }
  for (const param of params) {
    const value = has(args, param.name) ? args[param.name] : param.default;
    if (value === undefined) {
      if (param.required) errors.push(`필수 인자 없음: ${param.name}`);
    } else if (!valueMatchesParamType(param.type, value)) {
      errors.push(`타입이 맞지 않는 인자: ${param.name} (${param.type})`);
    }
  }
  if (errors.length > 0) throw new Error(errors.join("\n"));
}

function fieldsToRecord(
  draft: ArgsDraft,
  params: readonly WorkflowParam[],
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const param of params) {
    if (!has(draft.values, param.name)) continue;
    const text = draft.values[param.name] ?? "";
    if (param.type === "string") args[param.name] = text;
    if (param.type === "number") {
      const value = Number(text);
      if (!text.trim() || !Number.isFinite(value)) {
        throw new Error(`${param.name}은(는) 유한한 숫자여야 합니다.`);
      }
      args[param.name] = value;
    }
    if (param.type === "boolean") {
      if (text !== "true" && text !== "false")
        throw new Error(`${param.name}은(는) true 또는 false여야 합니다.`);
      args[param.name] = text === "true";
    }
    if (param.type === "json") {
      try {
        args[param.name] = JSON.parse(text) as unknown;
      } catch {
        throw new Error(`${param.name}은(는) 올바른 JSON이어야 합니다.`);
      }
    }
  }
  return args;
}

export function argsDraftToRecord(
  draft: ArgsDraft,
  params: readonly WorkflowParam[],
): Readonly<Record<string, unknown>> {
  const args = draft.mode === "json" ? readJsonObject(draft.json) : fieldsToRecord(draft, params);
  validateArgs(params, args);
  return args;
}

export function changeArgsMode(
  draft: ArgsDraft,
  params: readonly WorkflowParam[],
  mode: ArgsDraft["mode"],
): ArgsDraft {
  if (draft.mode === mode) return draft;
  const args = argsDraftToRecord(draft, params);
  return { ...createArgsDraft(params, args), mode };
}
