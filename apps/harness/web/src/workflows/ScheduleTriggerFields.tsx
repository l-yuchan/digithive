import type { ScheduleDraft } from "./scheduleDraft";
import type { Trigger } from "./workflowTypes";

type Props = {
  readonly draft: ScheduleDraft;
  readonly onChange: <K extends keyof ScheduleDraft>(key: K, value: ScheduleDraft[K]) => void;
};

function triggerKind(value: string): Trigger["kind"] {
  if (value === "once" || value === "interval" || value === "daily") return value;
  throw new Error("알 수 없는 반복 방식입니다.");
}

export function ScheduleTriggerFields({ draft, onChange }: Props) {
  return (
    <div className="form-grid">
      <label className="field">
        <span>반복 방식</span>
        <select
          value={draft.triggerKind}
          onChange={(event) => onChange("triggerKind", triggerKind(event.target.value))}
          data-testid="schedule-trigger-kind"
        >
          <option value="once">한 번</option>
          <option value="interval">일정 간격</option>
          <option value="daily">매일</option>
        </select>
      </label>
      {draft.triggerKind === "once" ? (
        <label className="field">
          <span>실행 시각</span>
          <input
            type="datetime-local"
            value={draft.onceAt}
            onChange={(event) => onChange("onceAt", event.target.value)}
            required
          />
        </label>
      ) : null}
      {draft.triggerKind === "interval" ? (
        <>
          <label className="field">
            <span>실행 간격(초)</span>
            <input
              type="number"
              min={1}
              step={1}
              value={draft.everySeconds}
              onChange={(event) => onChange("everySeconds", event.target.value)}
              required
            />
          </label>
          <label className="field">
            <span>간격 기준 시각</span>
            <input
              type="datetime-local"
              value={draft.anchorAt}
              onChange={(event) => onChange("anchorAt", event.target.value)}
              required
            />
          </label>
        </>
      ) : null}
      {draft.triggerKind === "daily" ? (
        <>
          <label className="field">
            <span>실행 시간</span>
            <input
              type="time"
              value={draft.dailyTime}
              onChange={(event) => onChange("dailyTime", event.target.value)}
              required
            />
          </label>
          <label className="field">
            <span>IANA 시간대</span>
            <input
              value={draft.timeZone}
              onChange={(event) => onChange("timeZone", event.target.value)}
              placeholder="Asia/Seoul"
              required
            />
          </label>
        </>
      ) : null}
      <label className="enabled-toggle field-wide">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => onChange("enabled", event.target.checked)}
        />
        자동 실행 사용
      </label>
    </div>
  );
}
