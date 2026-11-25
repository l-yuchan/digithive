import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { apiUrl, getJson, postJson, sendJson } from "../api";
import { reportAsync } from "../async";
import {
  AccountsResponseSchema,
  type Account,
  type AccountSource,
  type AccountsResponse,
} from "./accounts";
import { AccountCard } from "./AccountCard";
import { readOAuthError } from "./oauth";

function configuredLabel(
  state: AccountsResponse | null,
  failed: boolean,
  configured: boolean,
): string {
  if (state === null) return failed ? "확인 불가" : "확인 중";
  return configured ? "설정됨" : "미설정";
}

export function AccountsPanel({ onChanged }: { readonly onChanged: () => void }) {
  const [state, setState] = useState<AccountsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [oauthError] = useState(() => readOAuthError(window.location.search));

  const load = useCallback(
    () =>
      getJson("/api/accounts", AccountsResponseSchema)
        .then((body) => {
          setState(body);
          setLoadError(null);
        })
        .catch((error: unknown) => setLoadError(String(error))),
    [],
  );

  const refresh = async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void load().catch((error: unknown) => setLoadError(String(error)));
    const timer = window.setInterval(
      () => reportAsync(load(), (error) => setLoadError(String(error))),
      20_000,
    );
    return () => window.clearInterval(timer);
  }, [load]);

  const runAction = async (key: string, request: () => Promise<unknown>) => {
    setBusyKey(key);
    setActionError(null);
    try {
      await request();
      await load();
      onChanged();
    } catch (error) {
      setActionError(String(error));
    } finally {
      setBusyKey(null);
    }
  };

  const toggleSource = (account: Account, source: AccountSource["source"], enabled: boolean) => {
    reportAsync(
      runAction(`source:${account.id}:${source}`, () =>
        sendJson(
          "PATCH",
          `/api/accounts/${encodeURIComponent(account.id)}/sources/${source}`,
          { enabled },
          z.unknown(),
        ),
      ),
      (error) => setActionError(String(error)),
    );
  };

  const remove = (account: Account) => {
    reportAsync(
      runAction(`delete:${account.id}`, async () => {
        await sendJson(
          "DELETE",
          `/api/accounts/${encodeURIComponent(account.id)}`,
          undefined,
          z.unknown(),
        );
        setConfirmDelete(null);
      }),
      (error) => setActionError(String(error)),
    );
  };

  const visibleAccounts =
    state?.accounts.filter(
      (account) =>
        account.id !== "google-default" || account.provider !== "google" || account.connected,
    ) ?? [];

  const addGoogle = (
    <a
      className="primary button-link"
      href={apiUrl("/api/oauth/google/start")}
      data-testid="google-connect"
    >
      Google 계정 추가
    </a>
  );

  return (
    <section className="accounts" aria-label="계정 관리">
      <div className="card">
        <div className="card-head">
          <h2>계정</h2>
          <div className="run-actions compact-actions">
            {state && visibleAccounts.length > 0 && state.googleConfigured ? addGoogle : null}
            <button
              className="ghost"
              type="button"
              disabled={refreshing || busyKey !== null}
              onClick={() => reportAsync(refresh(), (error) => setLoadError(String(error)))}
              data-testid="accounts-refresh"
            >
              {refreshing ? "새로고침 중…" : "새로고침"}
            </button>
          </div>
        </div>
        <div className="configuration-states">
          <span className={`badge ${state?.googleConfigured === false ? "failed" : ""}`}>
            Google OAuth ·{" "}
            {configuredLabel(state, loadError !== null, state?.googleConfigured ?? false)}
          </span>
          <span className={`badge ${state?.canvasConfigured === false ? "failed" : ""}`}>
            Canvas · {configuredLabel(state, loadError !== null, state?.canvasConfigured ?? false)}
          </span>
        </div>
      </div>

      {oauthError ? (
        <div className="error-card" role="alert" data-testid="google-oauth-error">
          <p className="error">Google 연결에 실패했습니다: {oauthError}</p>
        </div>
      ) : null}
      {loadError ? (
        <div className="error-card" role="alert" data-testid="accounts-load-error">
          <p className="error">계정 상태를 불러오지 못했습니다: {loadError}</p>
          <button
            className="ghost"
            type="button"
            disabled={refreshing}
            onClick={() => reportAsync(refresh(), (error) => setLoadError(String(error)))}
          >
            다시 시도
          </button>
        </div>
      ) : null}
      {actionError ? (
        <p className="error" role="alert">
          {actionError}
        </p>
      ) : null}

      {state === null ? (
        <div className="card empty-state">
          <p className="run-meta">
            {loadError
              ? "계정 상태를 확인할 수 없습니다. 위의 다시 시도를 눌러주세요."
              : "계정 상태를 불러오는 중입니다."}
          </p>
        </div>
      ) : visibleAccounts.length === 0 ? (
        <div className="card empty-state" data-testid="accounts-empty">
          <p className="run-meta">연결된 계정이 없습니다.</p>
          {state.googleConfigured ? (
            addGoogle
          ) : (
            <p className="run-meta">Google OAuth가 설정되지 않아 계정을 추가할 수 없습니다.</p>
          )}
        </div>
      ) : (
        visibleAccounts.map((account) => (
          <AccountCard
            key={account.id}
            account={account}
            googleConfigured={state.googleConfigured}
            busyKey={busyKey}
            confirmDelete={confirmDelete === account.id}
            onSync={() =>
              reportAsync(
                runAction(`sync:${account.id}`, () =>
                  postJson(`/api/accounts/${encodeURIComponent(account.id)}/sync`, {}, z.unknown()),
                ),
                (error) => setActionError(String(error)),
              )
            }
            onToggleSource={(source, enabled) => toggleSource(account, source, enabled)}
            onDeleteStart={() => setConfirmDelete(account.id)}
            onDeleteCancel={() => setConfirmDelete(null)}
            onDelete={() => remove(account)}
          />
        ))
      )}
    </section>
  );
}
