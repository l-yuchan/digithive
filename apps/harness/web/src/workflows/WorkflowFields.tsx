import { ErrorMessage } from "./ErrorMessage";
import type { WorkflowDraft } from "./workflowDraft";
import type { CapabilityGroup } from "./workflowTypes";

export type ChangeWorkflowDraft = <K extends keyof WorkflowDraft>(
  key: K,
  value: WorkflowDraft[K],
) => void;

type Props = {
  readonly draft: WorkflowDraft;
  readonly accountsError: string | null;
  readonly onChange: ChangeWorkflowDraft;
};

const CAPABILITIES: readonly { id: CapabilityGroup; label: string; access: string }[] = [
  { id: "workflow.read", label: "워크플로 읽기", access: "읽기" },
  { id: "memory.read", label: "기억 읽기", access: "읽기" },
  { id: "files.read", label: "파일 읽기", access: "읽기" },
  { id: "account.read", label: "계정·켜진 정보 읽기", access: "읽기" },
  { id: "mail.send", label: "알림 보내기·브리핑 만들기", access: "쓰기" },
  { id: "workflow.write", label: "워크플로 쓰기", access: "쓰기" },
  { id: "memory.write", label: "기억 쓰기", access: "쓰기" },
  { id: "schedule.write", label: "스케줄 쓰기", access: "쓰기" },
  { id: "workflow.run", label: "워크플로 실행", access: "실행" },
];

/** The app's own collection job takes the account as its first argument. */
function isBuiltinCollection(path: string): boolean {
  return path.trim() === "@builtin/collection.ts";
}

function executorKind(value: string): "agent" | "script" {
  if (value === "agent" || value === "script") return value;
  throw new Error("알 수 없는 실행 방식입니다.");
}

export function ExecutorFields({ draft, accountsError, onChange }: Props) {
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
          <option value="script">스크립트</option>
        </select>
      </label>
      {draft.executorKind === "script" ? (
        <>
          <label className="field field-wide">
            <span>스크립트 파일 경로</span>
            <input
              value={draft.scriptPath}
              onChange={(event) => onChange("scriptPath", event.target.value)}
              placeholder="report.ts 또는 @builtin/collection.ts"
              required
            />
            <small>
              서버 scripts 기준의 상대 .ts/.js 경로입니다. @builtin/으로 시작하면 앱이 직접 싣는
              작업입니다: @builtin/collection.ts (연결 자료 수집), @builtin/briefing.ts (브리핑
              생성).
            </small>
          </label>
          <label className="field field-wide">
            <span>스크립트 인자 (줄당 하나)</span>
            <textarea
              rows={3}
              value={draft.scriptArgs}
              onChange={(event) => onChange("scriptArgs", event.target.value)}
            />
            {isBuiltinCollection(draft.scriptPath) ? (
              <small>첫 인자는 수집할 계정 id입니다. 연결 탭에서 계정 id를 확인하세요.</small>
            ) : null}
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
      {accountsError && draft.executorKind === "script" ? (
        <div className="field-wide">
          <ErrorMessage title="계정 정보를 불러오지 못했습니다." error={accountsError} />
        </div>
      ) : null}
    </div>
  );
}
