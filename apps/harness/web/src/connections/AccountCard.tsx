import type { Account, AccountSource } from "./accounts";
import { PROVIDER_LABELS } from "./accounts";
import { apiUrl } from "../api";
import { AccountSources } from "./AccountSources";

export function AccountCard({
  account,
  googleConfigured,
  busyKey,
  confirmDelete,
  onToggleSource,
  onDeleteStart,
  onDeleteCancel,
  onDelete,
}: {
  readonly account: Account;
  readonly googleConfigured: boolean;
  readonly busyKey: string | null;
  readonly confirmDelete: boolean;
  readonly onToggleSource: (source: AccountSource["source"], enabled: boolean) => void;
  readonly onDeleteStart: () => void;
  readonly onDeleteCancel: () => void;
  readonly onDelete: () => void;
}) {
  const busy = busyKey !== null;
  return (
    <article className="card account-card" data-testid="account-row" data-account-id={account.id}>
      <div className="card-head">
        <div className="account-title">
          <h3>{account.label}</h3>
          <p className="run-meta">
            {PROVIDER_LABELS[account.provider]}
            {account.email ? ` · ${account.email}` : ""}
          </p>
          <p className="run-meta" data-testid="account-id">
            계정 ID {account.id}
            {account.subject ? ` · Google 사용자 ID ${account.subject}` : ""}
          </p>
        </div>
        <span className={`badge ${account.connected ? "succeeded" : "failed"}`}>
          {account.connected ? "연결됨" : "연결 끊김"}
        </span>
      </div>

      <AccountSources account={account} disabled={busy} onToggle={onToggleSource} />

      <div className="run-actions">
        {account.provider === "google" && googleConfigured ? (
          <a
            className="ghost button-link"
            href={apiUrl(`/api/oauth/google/start?accountId=${encodeURIComponent(account.id)}`)}
            data-testid="google-reconnect"
          >
            Google 다시 연결
          </a>
        ) : null}
        {confirmDelete ? (
          <>
            <button
              className="primary"
              type="button"
              disabled={busy}
              onClick={onDelete}
              data-testid="account-delete-confirm"
            >
              계정과 데이터 삭제
            </button>
            <button className="ghost" type="button" disabled={busy} onClick={onDeleteCancel}>
              취소
            </button>
          </>
        ) : (
          <button
            className="ghost danger-button"
            type="button"
            disabled={busy}
            onClick={onDeleteStart}
            data-testid="account-delete"
          >
            계정 삭제
          </button>
        )}
      </div>
      {confirmDelete ? (
        <p className="error" role="alert">
          이 계정과 수집된 데이터를 모두 삭제합니다. 되돌릴 수 없습니다.
        </p>
      ) : null}
      {account.provider === "google" && !googleConfigured ? (
        <p className="run-meta">Google OAuth가 설정되지 않아 다시 연결할 수 없습니다.</p>
      ) : null}
    </article>
  );
}
