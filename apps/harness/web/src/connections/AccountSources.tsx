import type { Account, AccountSource } from "./accounts";
import { SOURCE_LABELS } from "./accounts";
import { formatDateTime } from "../format";

function sourceState(
  source: AccountSource,
  connected: boolean,
): { label: string; className: string } {
  if (!source.enabled) return { label: "일시정지됨", className: "" };
  if (!connected) return { label: "연결 필요", className: "failed" };
  if (!source.lastAttemptAt && !source.lastSyncAt && !source.error)
    return { label: "확인 전", className: "" };
  return source.ok
    ? { label: "정상", className: "succeeded" }
    : { label: "오류", className: "failed" };
}

export function AccountSources({
  account,
  disabled,
  onToggle,
}: {
  readonly account: Account;
  readonly disabled: boolean;
  readonly onToggle: (source: AccountSource["source"], enabled: boolean) => void;
}) {
  if (account.sources.length === 0)
    return <p className="run-meta">이 계정에 등록된 수집 소스가 없습니다.</p>;

  return (
    <ul className="account-sources" data-testid="account-sources">
      {account.sources.map((source) => {
        const state = sourceState(source, account.connected);
        return (
          <li className="account-source" key={source.source} data-source={source.source}>
            <div className="source-head">
              <strong>{SOURCE_LABELS[source.source]}</strong>
              <span className={`badge ${state.className}`}>{state.label}</span>
              <label className="source-toggle">
                <input
                  type="checkbox"
                  checked={source.enabled}
                  disabled={disabled}
                  aria-label={`${SOURCE_LABELS[source.source]} 수집 사용`}
                  onChange={(event) => onToggle(source.source, event.target.checked)}
                />
                수집 사용
              </label>
            </div>
            <p className="run-meta">
              {source.enabled ? "자동 수집을 사용합니다." : "수집이 일시정지되어 있습니다."}
              {" · "}이어받기 정보 {source.cursor === null ? "없음" : "저장됨"}
            </p>
            <p className="run-meta">
              마지막 성공: {source.lastSyncAt ? formatDateTime(source.lastSyncAt) : "기록 없음"}
              <br />
              마지막 시도:{" "}
              {source.lastAttemptAt ? formatDateTime(source.lastAttemptAt) : "기록 없음"}
            </p>
            {source.error ? <p className="error">최근 오류: {source.error}</p> : null}
          </li>
        );
      })}
    </ul>
  );
}
