import { useState } from "react";
import { postJson } from "../api";
import { reportAsync } from "../async";
import { createArgsDraft, argsDraftToRecord, defaultWorkflowArgs } from "./argsDraft";
import { ErrorMessage } from "./ErrorMessage";
import { WorkflowArgsEditor } from "./WorkflowArgsEditor";
import { formatDateTime, runStatusLabel } from "../format";
import { WorkflowRunResponseSchema, type QueuedRun, type WorkflowView } from "./workflowTypes";

export function RunDialog({
  workflow,
  onChanged,
  onClose,
}: {
  readonly workflow: WorkflowView;
  readonly onChanged: () => Promise<void>;
  readonly onClose: () => void;
}) {
  const [draft, setDraft] = useState(() =>
    createArgsDraft(workflow.params, defaultWorkflowArgs(workflow.params)),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState<QueuedRun | null>(null);

  const run = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const args = argsDraftToRecord(draft, workflow.params);
      const body = await postJson(
        `/api/workflows/${encodeURIComponent(workflow.id)}/run`,
        { args },
        WorkflowRunResponseSchema,
      );
      setQueued(body.run);
      await onChanged();
    } catch (failure) {
      setError(String(failure));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="dialog-backdrop">
      <section
        className="card workflow-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workflow-run-title"
        data-testid="workflow-run-dialog"
      >
        <div className="card-head">
          <h3 id="workflow-run-title">지금 실행 · {workflow.title}</h3>
          <button className="icon" type="button" onClick={onClose} aria-label="실행 대화상자 닫기">
            ×
          </button>
        </div>
        {queued ? (
          <div className="queued-run" role="status" data-testid="workflow-run-queued">
            <strong>실행을 큐에 넣었습니다.</strong>
            <p className="run-meta">
              실행 ID: <code>{queued.id}</code>
            </p>
            <p className="run-meta">
              상태: {runStatusLabel(queued.status)} · 생성 {formatDateTime(queued.createdAt)}
            </p>
            <p>
              서버가 실행 완료를 기다린 것은 아닙니다. 아래 실행 기록에서 진행 상태와 결과를
              확인하세요.
            </p>
            <button className="primary" type="button" onClick={onClose}>
              실행 기록 보기
            </button>
          </div>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              reportAsync(run(), (failure) => setError(String(failure)));
            }}
          >
            <p className="run-meta">
              기본값을 채웠습니다. 필수 인자를 확인한 뒤 실행하면 작업이 큐에 추가됩니다.
            </p>
            <fieldset className="form-fields" disabled={submitting}>
              <WorkflowArgsEditor params={workflow.params} draft={draft} onChange={setDraft} />
            </fieldset>
            {error ? (
              <ErrorMessage
                title="실행을 요청하지 못했습니다. 서버 응답을 그대로 표시합니다."
                error={error}
                testId="workflow-run-error"
              />
            ) : null}
            <div className="run-actions">
              <button
                className="primary"
                type="submit"
                disabled={submitting}
                data-testid="workflow-run-submit"
              >
                {submitting ? "큐에 넣는 중…" : "실행 큐에 추가"}
              </button>
              <button className="ghost" type="button" disabled={submitting} onClick={onClose}>
                취소
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
