import { PROVIDER_LABELS, SOURCE_LABELS, type Account } from "../connections/accounts";
import { ErrorMessage } from "./ErrorMessage";
import type { WorkflowDraft } from "./workflowDraft";
import type { CapabilityGroup, Executor, SourceName } from "./workflowTypes";

export type ChangeWorkflowDraft = <K extends keyof WorkflowDraft>(
  key: K,
  value: WorkflowDraft[K],
) => void;

type Props = {
  readonly draft: WorkflowDraft;
  readonly accounts: readonly Account[];
  readonly accountsError: string | null;
  readonly onChange: ChangeWorkflowDraft;
};

const CAPABILITIES: readonly { id: CapabilityGroup; label: string; access: string }[] = [
  { id: "workflow.read", label: "워크플로 읽기", access: "읽기" },
  { id: "memory.read", label: "기억 읽기", access: "읽기" },
  { id: "mail.read", label: "메일 읽기", access: "읽기" },
  { id: "files.read", label: "파일 읽기", access: "읽기" },
  { id: "workflow.write", label: "워크플로 쓰기", access: "쓰기" },
  { id: "memory.write", label: "기억 쓰기", access: "쓰기" },
  { id: "schedule.write", label: "스케줄 쓰기", access: "쓰기" },
  { id: "workflow.run", label: "워크플로 실행", access: "실행" },
];

function executorKind(value: string): Executor["kind"] {
  if (value === "agent" || value === "builtin" || value === "script") return value;
  throw new Error("알 수 없는 실행 방식입니다.");
}

export function ExecutorFields({ draft, accounts, accountsError, onChange }: Props) {
  const account = accounts.find((candidate) => candidate.id === draft.accountId);
  const accountMissing = draft.accountId && !account;
  const toggleSource = (source: SourceName, checked: boolean) =>
    onChange(
      "sources",
      checked ? [...draft.sources, source] : draft.sources.filter((item) => item !== source),
    );
  const toggleCapability = (capability: CapabilityGroup, checked: boolean) =>
    onChange(
      "capabilities",
      checked
        ? [...draft.capabilities, capability]
        : draft.capabilities.filter((item) => item !== capability),
    );

  return (
    <div className="form-grid">
      <label className="field">
        <span>실행 방식</span>
        <select
          value={draft.executorKind}
          onChange={(event) => onChange("executorKind", executorKind(event.target.value))}
          data-testid="workflow-executor-kind"
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
            <select
              value={draft.builtinName}
              onChange={(event) =>
                onChange(
                  "builtinName",
                  event.target.value === "briefing" ? "briefing" : "sync_sources",
                )
              }
            >
              <option value="sync_sources">연결 자료 수집</option>
              <option value="briefing">브리핑 생성</option>
            </select>
          </label>
          <label className="field">
            <span>{draft.builtinName === "sync_sources" ? "수집 계정" : "계정 범위(선택)"}</span>
            <select
              value={draft.accountId}
              onChange={(event) => onChange("accountId", event.target.value)}
            >
              {draft.builtinName === "briefing" ? (
                <option value="">모든 계정</option>
              ) : (
                <option value="">계정 선택</option>
              )}
              {accountMissing ? (
                <option value={draft.accountId}>{draft.accountId} · 목록에 없음</option>
              ) : null}
              {accounts.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.label} · {PROVIDER_LABELS[item.provider]}
                  {item.email ? ` · ${item.email}` : ""}
                </option>
              ))}
            </select>
          </label>
          {draft.builtinName === "sync_sources" ? (
            <fieldset className="field field-wide source-picker">
              <legend>수집할 정보</legend>
              {!account ? <small>계정을 선택하면 제공 정보를 고를 수 있습니다.</small> : null}
              {account?.sources.map((source) => (
                <label key={source.source} className="source-toggle">
                  <input
                    type="checkbox"
                    checked={draft.sources.includes(source.source)}
                    onChange={(event) => toggleSource(source.source, event.target.checked)}
                  />
                  {SOURCE_LABELS[source.source]}
                  {source.enabled ? "" : " · 기능 꺼짐"}
                </label>
              ))}
            </fieldset>
          ) : null}
        </>
      ) : null}
      {draft.executorKind === "script" ? (
        <>
          <label className="field field-wide">
            <span>스크립트 파일 경로</span>
            <input
              value={draft.scriptPath}
              onChange={(event) => onChange("scriptPath", event.target.value)}
              placeholder="jobs/report.ts"
              required
            />
            <small>서버 scripts 기준의 상대 .ts/.js 경로입니다.</small>
          </label>
          <label className="field field-wide">
            <span>스크립트 인자 (줄당 하나)</span>
            <textarea
              rows={3}
              value={draft.scriptArgs}
              onChange={(event) => onChange("scriptArgs", event.target.value)}
            />
          </label>
          <fieldset className="capability-picker field-wide">
            <legend>스크립트 권한</legend>
            <p className="run-meta">
              기본은 모두 거부입니다. 읽기 권한도 체크할 때만 부여되며, 쓰기·실행 권한과 구분해
              표시합니다.
            </p>
            <div className="capability-grid">
              {CAPABILITIES.map((capability) => (
                <label className="enabled-toggle" key={capability.id}>
                  <input
                    type="checkbox"
                    checked={draft.capabilities.includes(capability.id)}
                    onChange={(event) => toggleCapability(capability.id, event.target.checked)}
                  />
                  <span>{capability.label}</span>
                  <span
                    className={`badge capability-${capability.access === "읽기" ? "read" : "write"}`}
                  >
                    {capability.access}
                  </span>
                  <code>{capability.id}</code>
                </label>
              ))}
            </div>
          </fieldset>
        </>
      ) : null}
      {accountsError && draft.executorKind === "builtin" ? (
        <div className="field-wide">
          <ErrorMessage title="계정 선택 정보를 불러오지 못했습니다." error={accountsError} />
        </div>
      ) : null}
    </div>
  );
}
