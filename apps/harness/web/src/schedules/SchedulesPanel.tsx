import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { getJson, postJson, sendJson } from "../api";
import { AccountsResponseSchema, type Account } from "../connections/accounts";
import { reportAsync } from "../async";
import { ScheduleForm } from "./ScheduleForm";
import { ScheduleHistory } from "./ScheduleHistory";
import { ScheduleList } from "./ScheduleList";
import { ScheduleSchema, type Schedule, type ScheduleInput } from "./scheduleTypes";

export function SchedulesPanel() {
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [form, setForm] = useState<{ readonly schedule: Schedule | null } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);

  const loadSchedules = useCallback(
    () =>
      getJson("/api/schedules", z.object({ schedules: z.array(ScheduleSchema) }))
        .then((body) => {
          setSchedules(body.schedules);
          setLoadError(null);
        })
        .catch((error: unknown) => setLoadError(String(error))),
    [],
  );

  const loadAccounts = useCallback(
    () =>
      getJson("/api/accounts", AccountsResponseSchema)
        .then((body) => {
          setAccounts(body.accounts);
          setAccountsError(null);
        })
        .catch((error: unknown) => setAccountsError(String(error))),
    [],
  );

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([loadSchedules(), loadAccounts()]);
    } finally {
      setRefreshing(false);
    }
  }, [loadAccounts, loadSchedules]);

  useEffect(() => {
    void Promise.all([loadSchedules(), loadAccounts()]).catch((error: unknown) =>
      setLoadError(String(error)),
    );
    const scheduleTimer = window.setInterval(
      () => reportAsync(loadSchedules(), (error) => setLoadError(String(error))),
      5_000,
    );
    const accountTimer = window.setInterval(
      () => reportAsync(loadAccounts(), (error) => setAccountsError(String(error))),
      20_000,
    );
    return () => {
      window.clearInterval(scheduleTimer);
      window.clearInterval(accountTimer);
    };
  }, [loadAccounts, loadSchedules]);

  const mutate = async (
    key: string,
    request: () => Promise<unknown>,
    after: () => void | Promise<void>,
  ) => {
    setBusyKey(key);
    setActionError(null);
    try {
      await request();
      await after();
    } catch (error) {
      setActionError(String(error));
    } finally {
      setBusyKey(null);
    }
  };

  const save = async (input: ScheduleInput) => {
    const current = form;
    if (!current) return;
    const request = current.schedule
      ? () =>
          sendJson(
            "PATCH",
            `/api/schedules/${encodeURIComponent(current.schedule?.id ?? "")}`,
            input,
            z.unknown(),
          )
      : () => postJson("/api/schedules", input, z.unknown());
    await request();
    setForm(null);
    await loadSchedules();
  };

  const remove = (schedule: Schedule) => {
    reportAsync(
      mutate(
        `delete:${schedule.id}`,
        () =>
          sendJson(
            "DELETE",
            `/api/schedules/${encodeURIComponent(schedule.id)}`,
            undefined,
            z.unknown(),
          ),
        async () => {
          setSelectedId((selected) => (selected === schedule.id ? null : selected));
          setForm((current) => (current?.schedule?.id === schedule.id ? null : current));
          await loadSchedules();
        },
      ),
      (error) => setActionError(String(error)),
    );
  };

  const selectedSchedule = schedules?.find((schedule) => schedule.id === selectedId) ?? null;

  return (
    <section className="schedules" aria-label="스케줄">
      <div className="card">
        <div className="card-head">
          <h2>통합 스케줄</h2>
          <div className="run-actions compact-actions">
            <button
              className="primary"
              type="button"
              onClick={() => setForm({ schedule: null })}
              data-testid="schedule-create"
            >
              새 스케줄
            </button>
            <button
              className="ghost"
              type="button"
              disabled={refreshing}
              onClick={() => reportAsync(refreshAll(), (error) => setLoadError(String(error)))}
              data-testid="schedules-refresh"
            >
              {refreshing ? "새로고침 중…" : "새로고침"}
            </button>
          </div>
        </div>
        <p className="run-meta">
          에이전트, 자료 수집, 브리핑, 서버 스크립트를 같은 목록에서 관리합니다.
        </p>
      </div>

      {loadError ? (
        <div className="error-card" role="alert" data-testid="schedules-load-error">
          <p className="error">스케줄을 불러오지 못했습니다: {loadError}</p>
          <button
            className="ghost"
            type="button"
            disabled={refreshing}
            onClick={() => reportAsync(refreshAll(), (error) => setLoadError(String(error)))}
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

      {form ? (
        <ScheduleForm
          key={form.schedule?.id ?? "new"}
          schedule={form.schedule}
          accounts={accounts}
          accountsError={accountsError}
          onSave={save}
          onCancel={() => setForm(null)}
        />
      ) : null}

      {schedules === null ? (
        <div className="card empty-state">
          <p className="run-meta">
            {loadError
              ? "스케줄을 확인할 수 없습니다. 위의 다시 시도를 눌러주세요."
              : "스케줄을 불러오는 중입니다."}
          </p>
        </div>
      ) : (
        <div className="schedule-columns">
          <section className="schedule-list-section" aria-label="스케줄 목록">
            <h2 className="section-title">스케줄 목록</h2>
            {schedules.length === 0 ? (
              <div className="card empty-state">
                <p className="run-meta">등록된 스케줄이 없습니다. 새 스케줄을 만들어주세요.</p>
              </div>
            ) : (
              <ScheduleList
                schedules={schedules}
                accounts={accounts}
                selectedId={selectedId}
                busyKey={busyKey}
                onEdit={(schedule) => setForm({ schedule })}
                onHistory={(id) => {
                  setSelectedId(id);
                  setHistoryVersion((version) => version + 1);
                }}
                onToggle={(schedule) =>
                  reportAsync(
                    mutate(
                      `toggle:${schedule.id}`,
                      () =>
                        sendJson(
                          "PATCH",
                          `/api/schedules/${encodeURIComponent(schedule.id)}`,
                          { enabled: !schedule.enabled },
                          z.unknown(),
                        ),
                      loadSchedules,
                    ),
                    (error) => setActionError(String(error)),
                  )
                }
                onRun={(schedule) =>
                  reportAsync(
                    mutate(
                      `run:${schedule.id}`,
                      () =>
                        postJson(
                          `/api/schedules/${encodeURIComponent(schedule.id)}/run`,
                          {},
                          z.unknown(),
                        ),
                      async () => {
                        setSelectedId(schedule.id);
                        setHistoryVersion((version) => version + 1);
                        await loadSchedules();
                      },
                    ),
                    (error) => setActionError(String(error)),
                  )
                }
                onDelete={remove}
              />
            )}
          </section>
          {selectedSchedule ? (
            <ScheduleHistory
              key={`${selectedSchedule.id}:${historyVersion}`}
              schedule={selectedSchedule}
              onChanged={() => reportAsync(loadSchedules(), (error) => setLoadError(String(error)))}
            />
          ) : (
            <div className="card empty-state history-placeholder">
              <p className="run-meta">
                {selectedId
                  ? "선택한 스케줄이 현재 목록에 없습니다."
                  : "실행 기록을 볼 스케줄을 선택하세요."}
              </p>
              {selectedId ? (
                <button className="ghost" type="button" onClick={() => setSelectedId(null)}>
                  선택 해제
                </button>
              ) : null}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
