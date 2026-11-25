import { useState } from "react";
import { postJson, sendJson } from "../api";
import { reportAsync } from "../async";
import { ErrorMessage } from "./ErrorMessage";
import { ScheduleTriggerFields } from "./ScheduleTriggerFields";
import { WorkflowArgsEditor } from "./WorkflowArgsEditor";
import { createScheduleDraft, scheduleDraftToInput, type ScheduleDraft } from "./scheduleDraft";
import { ScheduleBindingSchema, type ScheduleBinding, type WorkflowView } from "./workflowTypes";

export function ScheduleForm({
  workflow,
  schedule,
  onSaved,
  onCancel,
}: {
  readonly workflow: WorkflowView;
  readonly schedule: ScheduleBinding | null;
  readonly onSaved: () => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => createScheduleDraft(workflow.params, schedule));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  function change<K extends keyof ScheduleDraft>(key: K, value: ScheduleDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const input = scheduleDraftToInput(draft, workflow.params);
      if (schedule) {
        await sendJson(
          "PATCH",
          `/api/schedules/${encodeURIComponent(schedule.id)}`,
          input,
          ScheduleBindingSchema,
        );
      } else {
        await postJson(
          "/api/schedules",
          { workflowId: workflow.id, ...input },
          ScheduleBindingSchema,
        );
      }
      await onSaved();
    } catch (failure) {
      setError(String(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="card schedule-binding-form"
      data-testid="schedule-binding-form"
      onSubmit={(event) => {
        event.preventDefault();
        reportAsync(save(), (failure) => setError(String(failure)));
      }}
    >
      <div className="card-head">
        <h3>{schedule ? "스케줄 수정" : "새 스케줄 연결"}</h3>
        {schedule ? <span className="badge">{schedule.id}</span> : null}
      </div>
      <p className="run-meta">
        이 양식은 트리거와 인자만 바꿉니다. 워크플로 정의는 그대로 유지됩니다.
      </p>
      <fieldset className="form-fields" disabled={saving}>
        <ScheduleTriggerFields draft={draft} onChange={change} />
        <WorkflowArgsEditor
          params={workflow.params}
          draft={draft.args}
          onChange={(args) => change("args", args)}
        />
      </fieldset>
      {error ? (
        <ErrorMessage
          title="스케줄을 저장하지 못했습니다. 서버 응답을 그대로 표시합니다."
          error={error}
          testId="schedule-save-error"
        />
      ) : null}
      <div className="run-actions">
        <button className="primary" type="submit" disabled={saving} data-testid="schedule-save">
          {saving ? "저장 중…" : "스케줄 저장"}
        </button>
        <button className="ghost" type="button" disabled={saving} onClick={onCancel}>
          취소
        </button>
      </div>
    </form>
  );
}
