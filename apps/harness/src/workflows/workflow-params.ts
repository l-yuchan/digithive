import { MAX_PARAM_JSON, valueMatchesParamType, type WorkflowParam } from "./workflow-types";

export type ParamResolution =
  | { readonly ok: true; readonly values: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Applies defaults, rejects keys the definition never declared, and refuses a
 * value that does not match its declared type. The same function guards a binding
 * at save time and a run at invocation time, so a definition edit cannot leave a
 * binding that fails only when it fires.
 */
export function resolveWorkflowParams(
  declared: readonly WorkflowParam[],
  provided: Readonly<Record<string, unknown>>,
): ParamResolution {
  const errors: string[] = [];
  const known = new Set(declared.map((param) => param.name));
  for (const key of Object.keys(provided)) {
    if (!known.has(key)) errors.push(`unknown_param:${key}`);
  }
  const values: Record<string, unknown> = {};
  for (const param of declared) {
    const given = Object.prototype.hasOwnProperty.call(provided, param.name)
      ? provided[param.name]
      : undefined;
    const value = given === undefined ? param.default : given;
    if (value === undefined) {
      if (param.required) errors.push(`missing_param:${param.name}`);
      continue;
    }
    if (!valueMatchesParamType(param.type, value)) {
      errors.push(`invalid_param:${param.name}`);
      continue;
    }
    values[param.name] = value;
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, values };
}

/** A binding's stored args are exactly what a scheduled run would hand over. */
export function bindingArgsProblem(
  declared: readonly WorkflowParam[],
  args: Readonly<Record<string, unknown>>,
): string | null {
  const resolution = resolveWorkflowParams(declared, args);
  if (resolution.ok) return null;
  return resolution.errors.join(", ");
}

export { MAX_PARAM_JSON };
