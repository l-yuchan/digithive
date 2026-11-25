import type { Account } from "../connections/accounts";
import { PROVIDER_LABELS } from "../connections/accounts";
import type { ScheduleDraft } from "./scheduleDraft";

export type ChangeDraft = <K extends keyof ScheduleDraft>(key: K, value: ScheduleDraft[K]) => void;

type DraftProps = {
  readonly draft: ScheduleDraft;
  readonly onChange: ChangeDraft;
};

function triggerKind(value: string): ScheduleDraft["triggerKind"] {
  if (value === "once" || value === "interval" || value === "daily") return value;
  throw new Error("알 수 없는 반복 방식입니다.");
}

function executorKind(value: string): ScheduleDraft["executorKind"] {
  if (value === "agent" || value === "builtin" || value === "script") return value;
  throw new Error("알 수 없는 실행 방식입니다.");
}

function builtinName(value: string): ScheduleDraft["builtinName"] {
  if (value === "sync_sources" || value === "briefing") return value;
  throw new Error("알 수 없는 내장 작업입니다.");
}

export function TriggerFields({ draft, onChange }: DraftProps) {
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
          <input type="datetime-local" value={draft.onceAt} onChange={(event) => onChange("onceAt", event.target.value)} required />
        </label>
      ) : null}
      {draft.triggerKind === "interval" ? (
        <>
          <label className="field">
            <span>실행 간격(초)</span>
            <input type="number" min={1} step={1} value={draft.everySeconds} onChange={(event) => onChange("everySeconds", event.target.value)} required />
          </label>
          <label className="field">
            <span>간격 기준 시각</span>
            <input type="datetime-local" value={draft.anchorAt} onChange={(event) => onChange("anchorAt", event.target.value)} required />
          </label>
        </>
      ) : null}
      {draft.triggerKind === "daily" ? (
        <>
          <label className="field">
            <span>실행 시간</span>
            <input type="time" value={draft.dailyTime} onChange={(event) => onChange("dailyTime", event.target.value)} required />
          </label>
          <label className="field">
            <span>시간대</span>
            <input value={draft.timeZone} onChange={(event) => onChange("timeZone", event.target.value)} placeholder="Asia/Seoul" required />
            <small>Asia/Seoul 같은 IANA 시간대를 입력하세요.</small>
          </label>
        </>
      ) : null}
    </div>
  );
}

export function ExecutorFields({
  draft,
  accounts,
  accountsError,
  onChange,
}: DraftProps & {
  readonly accounts: readonly Account[];
  readonly accountsError: string | null;
}) {
  const accountMissing = draft.accountId.length > 0 && !accounts.some((account) => account.id === draft.accountId);
  return (
    <div className="form-grid">
      <label className="field">
        <span>실행 방식</span>
        <select
          value={draft.executorKind}
          onChange={(event) => onChange("executorKind", executorKind(event.target.value))}
          data-testid="schedule-executor-kind"
        >
          <option value="agent">에이전트</option>
          <option value="builtin">내장 작업</option>
          <option value="script">스크립트</option>
        </select>
      </label>
      {draft.executorKind === "builtin" ? (
        <>
          <label className="field">
            <span>내장 작업</span>
            <select value={draft.builtinName} onChange={(event) => onChange("builtinName", builtinName(event.target.value))}>
              <option value="sync_sources">연결 자료 수집</option>
              <option value="briefing">브리핑 생성</option>
            </select>
          </label>
          <label className="field">
            <span>계정 범위(선택)</span>
            <select value={draft.accountId} onChange={(event) => onChange("accountId", event.target.value)}>
              <option value="">모든 계정</option>
              {accountMissing ? <option value={draft.accountId}>{draft.accountId} · 현재 목록에 없음</option> : null}
              {accounts.map((account) => (
                <option value={account.id} key={account.id}>
                  {account.label} · {PROVIDER_LABELS[account.provider]}{account.email ? ` · ${account.email}` : ""}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : null}
      {draft.executorKind === "script" ? (
        <>
          <label className="field field-wide">
            <span>스크립트 파일 경로</span>
            <input value={draft.scriptPath} onChange={(event) => onChange("scriptPath", event.target.value)} placeholder="jobs/report.ts" required />
            <small>서버 scripts 디렉터리 기준의 상대 .ts/.js 파일 경로입니다. 셸 명령어가 아니며 상위 디렉터리로 이동할 수 없습니다.</small>
          </label>
          <label className="field field-wide">
            <span>스크립트 인자(선택)</span>
            <textarea rows={3} value={draft.scriptArgs} onChange={(event) => onChange("scriptArgs", event.target.value)} placeholder="인자를 줄당 하나씩 입력" />
            <small>셸 명령줄이 아닙니다. 각 줄이 실행 인자 하나로 전달됩니다.</small>
          </label>
        </>
      ) : null}
      {accountsError && draft.executorKind === "builtin" ? (
        <p className="error field-wide" role="alert">계정 선택 정보를 불러오지 못했습니다: {accountsError}</p>
      ) : null}
    </div>
  );
}
