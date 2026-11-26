import { formatDateTime } from "../format";
import type { Executor, WorkflowView } from "./workflowTypes";

function executorLabel(executor: Executor): string {
  return executor.kind === "agent" ? "에이전트" : "스크립트";
}

/** The app's own jobs are scripts whose path begins with `@builtin/`. */
const JOB_LABELS: Readonly<Record<string, string>> = {
  "@builtin/collection.ts": "연결 자료 수집",
  "@builtin/briefing.ts": "브리핑 생성",
};

export function WorkflowDefinition({ workflow }: { readonly workflow: WorkflowView }) {
  const executor = workflow.executor;
  const job = executor.kind === "script" ? JOB_LABELS[executor.path] : undefined;
  return (
    <>
      <section className="card workflow-definition" aria-label="워크플로 정의">
        <div className="card-head">
          <h3>정의</h3>
          <span className="badge">{executorLabel(executor)}</span>
          {job ? <span className="badge">앱 제공 작업</span> : null}
        </div>
        <p className="workflow-instruction">{workflow.instruction}</p>
        <p className="run-meta">
          제한 시간: {workflow.timeoutSeconds}초 · 수정 {formatDateTime(workflow.updatedAt)}
        </p>
        {executor.kind === "script" ? (
          <div className="executor-summary">
            <p className="run-meta">
              경로: <code>{executor.path}</code>
              {job ? ` · ${job}` : ""}
            </p>
            <p className="run-meta">
              인자:{" "}
              {executor.args.length > 0
                ? executor.args.map((arg) => JSON.stringify(arg)).join(" · ")
                : "없음"}
            </p>
            <p className="run-meta">
              권한:{" "}
              {executor.capabilities?.length
                ? executor.capabilities.join(", ")
                : "없음 · 모든 읽기/쓰기/실행 거부"}
            </p>
          </div>
        ) : null}
      </section>
      <section className="card workflow-params" aria-label="워크플로 파라미터">
        <div className="card-head">
          <h3>파라미터</h3>
          <span className="badge">{workflow.params.length}개</span>
        </div>
        {workflow.params.length === 0 ? (
          <p className="run-meta">파라미터 없이 실행되는 정의입니다.</p>
        ) : null}
        <ul className="definition-param-list">
          {workflow.params.map((param) => (
            <li key={param.name}>
              <div>
                <code>{param.name}</code>
                <span className="badge">{param.type}</span>
                {param.required ? (
                  <span className="badge awaiting_approval">필수</span>
                ) : (
                  <span className="badge">선택</span>
                )}
              </div>
              {param.description ? <p className="run-meta">{param.description}</p> : null}
              <p className="run-meta">
                기본값: {param.default === undefined ? "없음" : JSON.stringify(param.default)}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
