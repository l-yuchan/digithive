import { MAX_WORKFLOW_PARAMS, WorkflowParamTypeSchema } from "./workflowTypes";
import { emptyParamDraft, type ParamDraft } from "./workflowDraft";

export function WorkflowParamsEditor({
  rows,
  onChange,
}: {
  readonly rows: readonly ParamDraft[];
  readonly onChange: (rows: readonly ParamDraft[]) => void;
}) {
  function update<K extends keyof ParamDraft>(index: number, key: K, value: ParamDraft[K]) {
    onChange(rows.map((row, current) => (current === index ? { ...row, [key]: value } : row)));
  }

  return (
    <section className="params-editor" aria-label="워크플로 파라미터 편집">
      <div className="card-head">
        <div>
          <h3>파라미터</h3>
          <p className="run-meta">실행과 스케줄에서 사용할 인자를 선언합니다. 최대 16개입니다.</p>
        </div>
        <button
          className="ghost"
          type="button"
          disabled={rows.length >= MAX_WORKFLOW_PARAMS}
          onClick={() => onChange([...rows, emptyParamDraft()])}
          data-testid="workflow-param-add"
        >
          파라미터 추가
        </button>
      </div>
      {rows.length === 0 ? <p className="run-meta">선언된 파라미터가 없습니다.</p> : null}
      <ol className="param-list">
        {rows.map((row, index) => (
          <li className="param-row" key={index}>
            <div className="param-row-head">
              <strong>파라미터 {index + 1}</strong>
              <button
                className="ghost danger-button"
                type="button"
                onClick={() => onChange(rows.filter((_, current) => current !== index))}
                data-testid="workflow-param-remove"
              >
                삭제
              </button>
            </div>
            <div className="form-grid">
              <label className="field">
                <span>이름</span>
                <input
                  value={row.name}
                  maxLength={32}
                  pattern="[a-zA-Z][a-zA-Z0-9_]{0,31}"
                  onChange={(event) => update(index, "name", event.target.value)}
                  placeholder="report_date"
                  required
                />
                <small>영문자로 시작, 영문자·숫자·밑줄 1~32자</small>
              </label>
              <label className="field">
                <span>타입</span>
                <select
                  value={row.type}
                  onChange={(event) =>
                    update(index, "type", WorkflowParamTypeSchema.parse(event.target.value))
                  }
                >
                  <option value="string">문자열</option>
                  <option value="number">숫자</option>
                  <option value="boolean">참/거짓</option>
                  <option value="json">JSON</option>
                </select>
              </label>
              <label className="enabled-toggle field-wide">
                <input
                  type="checkbox"
                  checked={row.required}
                  onChange={(event) => update(index, "required", event.target.checked)}
                />
                필수 인자
              </label>
              <label className="field field-wide">
                <span>기본값 (JSON, 선택)</span>
                <input
                  value={row.defaultText}
                  onChange={(event) => update(index, "defaultText", event.target.value)}
                  placeholder='예: "값", 10, true, {"key":"value"}'
                />
                <small>비우면 기본값이 없습니다. 문자열에는 큰따옴표가 필요합니다.</small>
              </label>
              <label className="field field-wide">
                <span>설명 (선택)</span>
                <input
                  value={row.description}
                  maxLength={200}
                  onChange={(event) => update(index, "description", event.target.value)}
                />
              </label>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
