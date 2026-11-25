import { useCallback, useEffect, useState } from "react";
import { getJson } from "../api";
import { reportAsync } from "../async";
import { AccountsResponseSchema, type Account } from "../connections/accounts";
import { ErrorMessage } from "./ErrorMessage";
import { WorkflowDetail } from "./WorkflowDetail";
import { WorkflowForm } from "./WorkflowForm";
import { WorkflowList } from "./WorkflowList";
import {
  ACTIVE_RUN_STATUSES,
  SchedulesResponseSchema,
  WorkflowDetailResponseSchema,
  WorkflowsResponseSchema,
  type RunSummary,
  type ScheduleBindingView,
  type Workflow,
  type WorkflowView,
} from "./workflowTypes";

type SearchMode = "keyword" | "regex" | "bm25";
type Search = { readonly mode: SearchMode; readonly query: string };
type Detail = {
  readonly workflow: WorkflowView;
  readonly schedules: readonly ScheduleBindingView[];
  readonly runs: readonly RunSummary[];
};

function searchMode(value: string): SearchMode {
  if (value === "keyword" || value === "regex" || value === "bm25") return value;
  throw new Error("알 수 없는 검색 방식입니다.");
}

export function WorkflowsPanel() {
  const [workflows, setWorkflows] = useState<WorkflowView[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [editor, setEditor] = useState<Workflow | null | "new">(null);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("keyword");
  const [search, setSearch] = useState<Search>({ mode: "keyword", query: "" });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<{ id: string; message: string } | null>(null);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadList = useCallback(() => {
    const params = new URLSearchParams();
    if (search.query.trim()) params.set(search.mode, search.query.trim());
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return getJson(`/api/workflows${suffix}`, WorkflowsResponseSchema)
      .then((body) => {
        setWorkflows(body.workflows);
        setSelectedId((current) =>
          current && body.workflows.some((workflow) => workflow.id === current)
            ? current
            : (body.workflows[0]?.id ?? null),
        );
        setLoadError(null);
      })
      .catch((error: unknown) => setLoadError(String(error)));
  }, [search]);

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

  const loadDetail = useCallback(() => {
    if (!selectedId) return Promise.resolve();
    const id = encodeURIComponent(selectedId);
    return Promise.all([
      getJson(`/api/workflows/${id}`, WorkflowDetailResponseSchema),
      getJson(`/api/schedules?workflowId=${id}`, SchedulesResponseSchema),
    ])
      .then(([workflowBody, scheduleBody]) => {
        setDetail({
          workflow: workflowBody.workflow,
          schedules: scheduleBody.schedules,
          runs: workflowBody.runs,
        });
        setDetailError((current) => (current?.id === selectedId ? null : current));
      })
      .catch((error: unknown) => setDetailError({ id: selectedId, message: String(error) }));
  }, [selectedId]);

  useEffect(() => {
    void Promise.all([loadList(), loadAccounts()]).catch((error: unknown) =>
      setLoadError(String(error)),
    );
    const listTimer = window.setInterval(
      () => reportAsync(loadList(), (error) => setLoadError(String(error))),
      5_000,
    );
    const accountTimer = window.setInterval(
      () => reportAsync(loadAccounts(), (error) => setAccountsError(String(error))),
      20_000,
    );
    return () => {
      window.clearInterval(listTimer);
      window.clearInterval(accountTimer);
    };
  }, [loadAccounts, loadList]);

  const currentDetail = detail?.workflow.id === selectedId ? detail : null;
  const currentDetailError = detailError?.id === selectedId ? detailError.message : null;
  const active = currentDetail?.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status)) ?? false;
  useEffect(() => {
    if (!selectedId) return undefined;
    void loadDetail().catch((error: unknown) =>
      setDetailError({ id: selectedId, message: String(error) }),
    );
    const timer = window.setInterval(
      () =>
        reportAsync(loadDetail(), (error) =>
          setDetailError({ id: selectedId, message: String(error) }),
        ),
      active ? 2_000 : 5_000,
    );
    return () => window.clearInterval(timer);
  }, [active, loadDetail, selectedId]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([loadList(), loadAccounts(), loadDetail()]);
    } finally {
      setRefreshing(false);
    }
  };

  const saved = async (id: string, rebound: readonly string[]) => {
    setEditor(null);
    setSelectedId(id);
    setNotice(
      rebound.length > 0
        ? `워크플로를 저장했습니다. 강제 저장으로 인자를 다시 맞춘 스케줄: ${rebound.join(", ")}`
        : "워크플로를 저장했습니다.",
    );
    if (id !== selectedId) setDetail(null);
    setDetailError(null);
    await Promise.all([loadList(), id === selectedId ? loadDetail() : Promise.resolve()]);
  };

  const deleted = async () => {
    setEditor(null);
    setDetail(null);
    setDetailError(null);
    setSelectedId(null);
    setNotice("워크플로를 삭제했습니다. 실행 기록은 보존됩니다.");
    await loadList();
  };

  return (
    <section className="workflows" aria-label="워크플로">
      <div className="card workflows-intro">
        <div className="card-head">
          <div>
            <h2>워크플로</h2>
            <p className="run-meta">
              실행 정의를 재사용하고, 필요한 만큼 자동 실행 스케줄을 연결합니다.
            </p>
          </div>
          <button
            className="primary"
            type="button"
            onClick={() => setEditor("new")}
            data-testid="workflow-create"
          >
            새 워크플로
          </button>
        </div>
        <form
          className="workflow-search"
          onSubmit={(event) => {
            event.preventDefault();
            setSearch({ mode, query });
          }}
        >
          <label>
            <span className="visually-hidden">검색 방식</span>
            <select
              value={mode}
              onChange={(event) => setMode(searchMode(event.target.value))}
              data-testid="workflow-search-mode"
            >
              <option value="keyword">키워드</option>
              <option value="regex">정규식</option>
              <option value="bm25">BM25</option>
            </select>
          </label>
          <label>
            <span className="visually-hidden">워크플로 검색</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="제목과 실행 지시 검색"
              data-testid="workflow-search"
            />
          </label>
          <button className="ghost" type="submit">
            검색
          </button>
          <button
            className="ghost"
            type="button"
            disabled={refreshing}
            onClick={() => reportAsync(refresh(), (error) => setLoadError(String(error)))}
            data-testid="workflows-refresh"
          >
            {refreshing ? "새로고침 중…" : "새로고침"}
          </button>
        </form>
      </div>
      {loadError ? (
        <ErrorMessage
          title="워크플로 목록을 불러오지 못했습니다. 서버 응답을 그대로 표시합니다."
          error={loadError}
          testId="workflows-load-error"
        />
      ) : null}
      {currentDetailError ? (
        <ErrorMessage
          title="선택한 워크플로를 불러오지 못했습니다. 서버 응답을 그대로 표시합니다."
          error={currentDetailError}
          testId="workflow-detail-error"
        />
      ) : null}
      {accountsError ? (
        <ErrorMessage
          title="계정 정보를 불러오지 못했습니다. 서버 응답을 그대로 표시합니다."
          error={accountsError}
        />
      ) : null}
      {notice ? (
        <p className="workflow-notice" role="status">
          {notice}
        </p>
      ) : null}
      {editor !== null ? (
        <WorkflowForm
          key={editor === "new" ? "new" : editor.id}
          workflow={editor === "new" ? null : editor}
          accounts={accounts}
          accountsError={accountsError}
          onSaved={saved}
          onCancel={() => setEditor(null)}
        />
      ) : null}
      {workflows === null ? (
        <div className="card empty-state">
          <p className="run-meta">
            {loadError
              ? "목록을 확인할 수 없습니다. 새로고침으로 다시 시도하세요."
              : "워크플로를 불러오는 중입니다."}
          </p>
        </div>
      ) : (
        <div className="workflow-columns">
          <section className="workflow-list-section" aria-label="워크플로 목록">
            <h2 className="section-title">워크플로 목록</h2>
            <WorkflowList workflows={workflows} selectedId={selectedId} onSelect={setSelectedId} />
          </section>
          {currentDetail ? (
            <WorkflowDetail
              workflow={currentDetail.workflow}
              schedules={currentDetail.schedules}
              runs={currentDetail.runs}
              accounts={accounts}
              onEdit={() => setEditor(currentDetail.workflow)}
              onChanged={async () => {
                await Promise.all([loadList(), loadDetail()]);
              }}
              onDeleted={deleted}
            />
          ) : (
            <div className="card empty-state">
              <p className="run-meta">
                {selectedId
                  ? currentDetailError
                    ? "상세 정보를 확인할 수 없습니다. 새로고침으로 다시 시도하세요."
                    : "워크플로 상세 정보를 불러오는 중입니다."
                  : "워크플로를 선택하거나 새로 만드세요."}
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
