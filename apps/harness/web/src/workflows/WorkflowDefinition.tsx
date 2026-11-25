import { SOURCE_LABELS, type Account } from "../connections/accounts";
import { formatDateTime } from "../format";
import type { Executor, WorkflowView } from "./workflowTypes";

function executorLabel(executor: Executor): string {
  if (executor.kind === "agent") return "에이전트";
  if (executor.kind === "builtin")
    return executor.name === "sync_sources" ? "내장 · 연결 자료 수집" : "내장 · 브리핑 생성";
  return "스크립트";
}

export function WorkflowDefinition({
  workflow,
  accounts,
}: {
  readonly workflow: WorkflowView;
  readonly accounts: readonly Account[];
}) {
  const executor = workflow.executor;
  const account =
    executor.kind === "builtin"
      ? accounts.find((item) => item.id === executor.accountId)
      : undefined;
  return (
    <>
      <section className="card workflow-definition" aria-label="워크플로 정의">
        <div className="card-head">
          <h3>정의</h3>
          <span className="badge">{executorLabel(executor)}</span>
        </div>
        <p className="workflow-instruction">{workflow.instruction}</p>
        <p className="run-meta">
          제한 시간: {workflow.timeoutSeconds}초 · 수정 {formatDateTime(workflow.updatedAt)}
        </p>
        {executor.kind === "builtin" ? (
          <div className="executor-summary">
            <p className="run-meta">
              계정:{" "}
              {account?.label ??
                executor.accountId ??
                (executor.name === "sync_sources" ? "계정 미지정" : "모든 계정")}
              {executor.accountId && !account && accounts.length > 0 ? " · 현재 목록에 없음" : ""}
            </p>
            {executor.name === "sync_sources" ? (
              <p className="run-meta">
                수집 정보:{" "}
                {(executor.sources ?? []).map((source) => SOURCE_LABELS[source]).join(", ") ||
                  "계정의 사용 중인 정보"}
              </p>
            ) : null}
          </div>
        ) : null}
        {executor.kind === "script" ? (
          <div className="executor-summary">
            <p className="run-meta">
              경로: <code>{executor.path}</code>
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
