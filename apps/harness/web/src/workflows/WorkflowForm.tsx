import { useState } from "react";
import { postJson, sendJson } from "../api";
import type { Account } from "../connections/accounts";
import { reportAsync } from "../async";
import { ErrorMessage } from "./ErrorMessage";
import { ExecutorFields } from "./WorkflowFields";
import { WorkflowParamsEditor } from "./WorkflowParamsEditor";
import { createWorkflowDraft, workflowDraftToInput, type WorkflowDraft } from "./workflowDraft";
import { WorkflowMutationResponseSchema, WorkflowSchema, type Workflow } from "./workflowTypes";

export function WorkflowForm({
  workflow,
  accounts,
  accountsError,
  onSaved,
  onCancel,
}: {
  readonly workflow: Workflow | null;
  readonly accounts: readonly Account[];
  readonly accountsError: string | null;
  readonly onSaved: (id: string, rebound: readonly string[]) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState<WorkflowDraft>(() => createWorkflowDraft(workflow));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forceConflict, setForceConflict] = useState(false);

  function change<K extends keyof WorkflowDraft>(key: K, value: WorkflowDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  const save = async (force: boolean) => {
    setSaving(true);
    setError(null);
    setForceConflict(false);
    try {
      const input = workflowDraftToInput(draft);
      if (workflow) {
        const suffix = force ? "?force=1" : "";
        const body = await sendJson(
          "PATCH",
          `/api/workflows/${encodeURIComponent(workflow.id)}${suffix}`,
          input,
          WorkflowMutationResponseSchema,
        );
        await onSaved(body.workflow.id, body.rebound);
      } else {
        const created = await postJson("/api/workflows", input, WorkflowSchema);
        await onSaved(created.id, []);
      }
    } catch (failure) {
      const message = String(failure);
      setError(message);
      setForceConflict(message.includes('"schedule_args_invalid"'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="card workflow-form"
      data-testid="workflow-form"
      onSubmit={(event) => {
        event.preventDefault();
        reportAsync(save(false), (failure) => setError(String(failure)));
      }}
    >
      <div className="card-head">
        <h2>{workflow ? "워크플로 정의 수정" : "새 워크플로"}</h2>
        {workflow ? <span className="badge">{workflow.id}</span> : null}
      </div>
      <p className="run-meta">
        재사용할 실행 정의입니다. 자동 실행 시각은 아래 스케줄에서 별도로 연결합니다.
      </p>
      <fieldset className="form-fields" disabled={saving}>
        <div className="form-grid">
          <label className="field">
            <span>제목</span>
            <input
              value={draft.title}
              maxLength={200}
              onChange={(event) => change("title", event.target.value)}
              data-testid="workflow-title"
              required
            />
          </label>
          <label className="field">
            <span>제한 시간(초)</span>
            <input
              type="number"
              min={1}
              max={86_400}
              step={1}
              value={draft.timeoutSeconds}
              onChange={(event) => change("timeoutSeconds", event.target.value)}
              required
            />
          </label>
          <label className="field field-wide">
            <span>실행 지시</span>
            <textarea
              rows={5}
              value={draft.instruction}
              maxLength={4_096}
              onChange={(event) => change("instruction", event.target.value)}
              data-testid="workflow-instruction"
              required
            />
            <small>
              {draft.executorKind === "agent"
                ? "에이전트에게 전달할 재사용 프롬프트입니다."
                : "실행 목적과 결과를 알아볼 수 있는 설명입니다."}
            </small>
          </label>
        </div>
        <ExecutorFields
          draft={draft}
          accounts={accounts}
          accountsError={accountsError}
          onChange={change}
        />
        <WorkflowParamsEditor rows={draft.params} onChange={(params) => change("params", params)} />
      </fieldset>
      {error ? (
        <ErrorMessage
          title="워크플로를 저장하지 못했습니다. 서버 응답을 그대로 표시합니다."
          error={error}
          testId="workflow-save-error"
        />
      ) : null}
      {forceConflict ? (
        <div className="force-save">
          <p className="run-meta">
            강제 저장하면 기존 스케줄에서 새 정의와 맞는 인자만 남기고 나머지를 삭제합니다. 위의
            스케줄별 오류를 먼저 확인하세요.
          </p>
          <button
            className="ghost danger-button"
            type="button"
            disabled={saving}
            onClick={() => reportAsync(save(true), (failure) => setError(String(failure)))}
            data-testid="workflow-force-save"
          >
            유효한 인자만 남기고 강제 저장
          </button>
        </div>
      ) : null}
      <div className="run-actions">
        <button className="primary" type="submit" disabled={saving} data-testid="workflow-save">
          {saving ? "저장 중…" : workflow ? "정의 저장" : "워크플로 만들기"}
        </button>
        <button className="ghost" type="button" disabled={saving} onClick={onCancel}>
          취소
        </button>
      </div>
    </form>
  );
}
