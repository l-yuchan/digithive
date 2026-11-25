import { useState } from "react";
import type { Account } from "../connections/accounts";
import { reportAsync } from "../async";
import { createDraft, draftToInput, type ScheduleDraft } from "./scheduleDraft";
import { ExecutorFields, TriggerFields } from "./ScheduleFields";
import type { Schedule, ScheduleInput } from "./scheduleTypes";

export function ScheduleForm({
  schedule,
  accounts,
  accountsError,
  onSave,
  onCancel,
}: {
  readonly schedule: Schedule | null;
  readonly accounts: readonly Account[];
  readonly accountsError: string | null;
  readonly onSave: (input: ScheduleInput) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState<ScheduleDraft>(() => createDraft(schedule));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function change<K extends keyof ScheduleDraft>(key: K, value: ScheduleDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(draftToInput(draft));
    } catch (failure) {
      setError(String(failure));
    } finally {
      setSaving(false);
    }
  };

  const instructionHint =
    draft.executorKind === "agent"
      ? "에이전트에게 전달할 프롬프트입니다."
      : draft.executorKind === "script"
        ? "스크립트 실행을 구분할 설명입니다."
        : "내장 작업을 구분할 설명입니다.";

  return (
    <form
      className="card schedule-form"
      data-testid="schedule-form"
      onSubmit={(event) => {
        event.preventDefault();
        reportAsync(submit(), (failure) => setError(String(failure)));
      }}
    >
      <div className="card-head">
        <h2>{schedule ? "스케줄 수정" : "새 스케줄"}</h2>
        {schedule ? <span className="badge">{schedule.id}</span> : null}
      </div>
      <fieldset className="form-fields" disabled={saving}>
        <div className="form-grid">
          <label className="field">
            <span>제목</span>
            <input
              value={draft.title}
              onChange={(event) => change("title", event.target.value)}
              data-testid="schedule-title"
              required
            />
          </label>
          <label className="field">
            <span>제한 시간(초)</span>
            <input
              type="number"
              min={1}
              max={86400}
              step={1}
              value={draft.timeoutSeconds}
              onChange={(event) => change("timeoutSeconds", event.target.value)}
              required
            />
            <small>1~86400초, 기본값 1800초</small>
          </label>
          <label className="field field-wide">
            <span>실행 지시</span>
            <textarea
              rows={4}
              value={draft.instruction}
              onChange={(event) => change("instruction", event.target.value)}
              data-testid="schedule-instruction"
              required
            />
            <small>{instructionHint}</small>
          </label>
          <label className="enabled-toggle field-wide">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => change("enabled", event.target.checked)}
            />
            자동 실행 사용
          </label>
        </div>
        <TriggerFields draft={draft} onChange={change} />
        <ExecutorFields
          draft={draft}
          accounts={accounts}
          accountsError={accountsError}
          onChange={change}
        />
      </fieldset>
      {error ? (
        <p className="error form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="run-actions">
        <button className="primary" type="submit" disabled={saving} data-testid="schedule-save">
          {saving ? "저장 중…" : schedule ? "변경 저장" : "스케줄 만들기"}
        </button>
        <button className="ghost" type="button" disabled={saving} onClick={onCancel}>
          취소
        </button>
      </div>
    </form>
  );
}
