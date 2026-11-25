import type { Account, AccountSource } from "./accounts";
import { SOURCE_LABELS, type Collector } from "./accounts";
import { formatDateTime } from "../format";

/**
 * A source switch is a permission: it decides whether this account's information
 * may be used at all, by conversations, briefings and collection schedules. It is
 * not a collection switch; collection is an ordinary schedule.
 */
/** Why the last attempt ran, from the source's own detail field. */
const REASON_LABELS: Record<string, string> = {
  full_resync: "전체 재수집(커서 재설정)",
  full_resync_after_400: "전체 재수집(증분 요청 거부)",
  full_resync_after_410: "전체 재수집(커서 만료)",
};

function attemptNote(source: AccountSource): string {
  const reason = source.error;
  if (!reason) return "";
  return REASON_LABELS[reason] ?? `수집 참고: ${reason}`;
}

function sourceState(
  source: AccountSource,
  connected: boolean,
): { label: string; className: string } {
  if (!source.enabled) return { label: "사용 안 함", className: "" };
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
    return <p className="run-meta">이 계정에 등록된 기능이 없습니다.</p>;

  const collectors = account.collectors ?? [];
  const scheduleNames = (using: readonly Collector[]) =>
    using.map((schedule) => schedule.title).join(", ");
  return (
    <ul className="account-sources" data-testid="account-sources">
      {account.sources.map((source) => {
        const state = sourceState(source, account.connected);
        const using = collectors.filter((schedule) => schedule.enabled);
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
                  aria-label={`${SOURCE_LABELS[source.source]} 정보 사용`}
                  onChange={(event) => onToggle(source.source, event.target.checked)}
                />
                정보 사용
              </label>
            </div>
            <p className="run-meta">
              {source.enabled
                ? "대화 검색, 브리핑, 수집 스케줄이 이 정보를 사용할 수 있습니다."
                : "사용을 끄면 대화 검색·브리핑·수집이 모두 이 정보를 읽지 않습니다."}
            </p>
            <p className="run-meta">
              {using.length > 0
                ? `이 정보를 읽는 스케줄: ${scheduleNames(using)}`
                : "이 정보를 읽는 활성 스케줄이 없습니다. 수집하려면 스케줄 탭에서 수집 스케줄을 만드세요."}
            </p>
            <p className="run-meta">
              마지막 수집 성공:{" "}
              {source.lastSyncAt ? formatDateTime(source.lastSyncAt) : "기록 없음"}
              <br />
              마지막 수집 시도:{" "}
              {source.lastAttemptAt ? formatDateTime(source.lastAttemptAt) : "기록 없음"}
            </p>
            {source.error ? (
              <p className={source.ok ? "run-meta" : "error"}>
                {source.ok ? "" : "실패 원인: "}
                {source.ok ? attemptNote(source) : source.error}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
