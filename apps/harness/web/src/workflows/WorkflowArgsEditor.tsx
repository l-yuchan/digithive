import { useState } from "react";
import { changeArgsMode, type ArgsDraft } from "./argsDraft";
import { ErrorMessage } from "./ErrorMessage";
import type { WorkflowParam } from "./workflowTypes";

function emptyValue(param: WorkflowParam): string {
  if (param.type === "boolean") return "false";
  if (param.type === "json") return "null";
  return "";
}

export function WorkflowArgsEditor({
  params,
  draft,
  onChange,
}: {
  readonly params: readonly WorkflowParam[];
  readonly draft: ArgsDraft;
  readonly onChange: (draft: ArgsDraft) => void;
}) {
  const [modeError, setModeError] = useState<string | null>(null);
  const setMode = (mode: ArgsDraft["mode"]) => {
    try {
      onChange(changeArgsMode(draft, params, mode));
      setModeError(null);
    } catch (error) {
      setModeError(String(error));
    }
  };
  const setValue = (name: string, value: string) =>
    onChange({ ...draft, values: { ...draft.values, [name]: value } });
  const toggle = (param: WorkflowParam, enabled: boolean) => {
    const values = { ...draft.values };
    if (enabled) values[param.name] = emptyValue(param);
    else delete values[param.name];
    onChange({ ...draft, values });
  };

  return (
    <section className="args-editor" aria-label="워크플로 인자">
      <div className="args-mode" role="group" aria-label="인자 입력 방식">
        <button
          className="ghost"
          type="button"
          aria-pressed={draft.mode === "fields"}
          onClick={() => setMode("fields")}
        >
          파라미터별 입력
        </button>
        <button
          className="ghost"
          type="button"
          aria-pressed={draft.mode === "json"}
          onClick={() => setMode("json")}
        >
          JSON으로 입력
        </button>
      </div>
      {modeError ? (
        <ErrorMessage title="입력 모드를 바꾸기 전에 인자를 확인하세요." error={modeError} />
      ) : null}
      {params.length === 0 ? (
        <p className="run-meta">이 워크플로는 파라미터가 없습니다. 빈 객체로 실행됩니다.</p>
      ) : null}
      {draft.mode === "json" ? (
        <label className="field">
          <span>인자 JSON 객체</span>
          <textarea
            rows={8}
            value={draft.json}
            onChange={(event) => onChange({ ...draft, json: event.target.value })}
            spellCheck={false}
            data-testid="workflow-args-json"
          />
          <small>선언된 이름만 사용할 수 있습니다. 생략한 값에는 정의의 기본값이 적용됩니다.</small>
        </label>
      ) : (
        <div className="args-fields">
          {params.map((param) => {
            const enabled = Object.prototype.hasOwnProperty.call(draft.values, param.name);
            const value = draft.values[param.name] ?? "";
            return (
              <div className="arg-field" key={param.name}>
                <label className="enabled-toggle">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(event) => toggle(param, event.target.checked)}
                  />
                  <strong>{param.name}</strong>
                  <span className="badge">{param.type}</span>
                  {param.required ? <span className="badge awaiting_approval">필수</span> : null}
                </label>
                {param.description ? <p className="run-meta">{param.description}</p> : null}
                {enabled && param.type === "string" ? (
                  <input
                    aria-label={`${param.name} 값`}
                    value={value}
                    maxLength={4_000}
                    onChange={(event) => setValue(param.name, event.target.value)}
                  />
                ) : null}
                {enabled && param.type === "number" ? (
                  <input
                    aria-label={`${param.name} 값`}
                    type="number"
                    value={value}
                    onChange={(event) => setValue(param.name, event.target.value)}
                  />
                ) : null}
                {enabled && param.type === "boolean" ? (
                  <select
                    aria-label={`${param.name} 값`}
                    value={value}
                    onChange={(event) => setValue(param.name, event.target.value)}
                  >
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                ) : null}
                {enabled && param.type === "json" ? (
                  <textarea
                    aria-label={`${param.name} 값`}
                    rows={4}
                    value={value}
                    onChange={(event) => setValue(param.name, event.target.value)}
                    spellCheck={false}
                  />
                ) : null}
                {!enabled ? (
                  <small>
                    값을 보내지 않음
                    {param.default !== undefined
                      ? ` · 기본값 ${JSON.stringify(param.default)} 적용`
                      : ""}
                  </small>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
