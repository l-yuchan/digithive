import { useState } from "react";
import { postJson, sendJson } from "../api";
import { reportAsync } from "../async";
import type { Account } from "../connections/accounts";
import { ErrorMessage } from "./ErrorMessage";
import { RunDialog } from "./RunDialog";
import { ScheduleForm } from "./ScheduleForm";
import { ScheduleSection } from "./ScheduleSection";
import { WorkflowDefinition } from "./WorkflowDefinition";
import { WorkflowHistory } from "./WorkflowHistory";
import {
  DeletedResponseSchema,
  DeleteWorkflowResponseSchema,
  ScheduleBindingSchema,
  ScheduleRunResponseSchema,
  type RunSummary,
  type ScheduleBinding,
  type ScheduleBindingView,
  type WorkflowView,
} from "./workflowTypes";

type Editor = { readonly schedule: ScheduleBinding | null; readonly workflow: WorkflowView };

export function WorkflowDetail({
  workflow,
  schedules,
  runs,
  accounts,
  onEdit,
  onChanged,
  onDeleted,
}: {
  readonly workflow: WorkflowView;
  readonly schedules: readonly ScheduleBindingView[];
  readonly runs: readonly RunSummary[];
  readonly accounts: readonly Account[];
  readonly onEdit: () => void;
  readonly onChanged: () => Promise<void>;
  readonly onDeleted: () => Promise<void>;
}) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [runSnapshot, setRunSnapshot] = useState<WorkflowView | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteConflict, setDeleteConflict] = useState(false);

  const mutate = async (key: string, request: () => Promise<string>) => {
    setBusyKey(key);
    setError(null);
    setNotice(null);
    try {
      const message = await request();
      await onChanged();
      setNotice(message);
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusyKey(null);
    }
  };

  const removeWorkflow = async (cascade: boolean) => {
    setBusyKey("delete:workflow");
    setError(null);
    setDeleteConflict(false);
    try {
      await sendJson(
        "DELETE",
        `/api/workflows/${encodeURIComponent(workflow.id)}${cascade ? "?cascade=1" : ""}`,
        undefined,
        DeleteWorkflowResponseSchema,
      );
      await onDeleted();
    } catch (failure) {
      const message = String(failure);
      setError(message);
      setDeleteConflict(message.includes('"schedules_present"'));
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="workflow-detail">
      <section className="card workflow-detail-head">
        <div>
          <h2>{workflow.title}</h2>
          <p className="run-meta">
            워크플로 ID: <code>{workflow.id}</code>
          </p>
        </div>
        <div className="run-actions compact-actions">
          <button
            className="primary"
            type="button"
            disabled={busyKey !== null}
            onClick={() => setRunSnapshot(workflow)}
            data-testid="workflow-run-now"
          >
            지금 실행
          </button>
          <button
            className="ghost"
            type="button"
            disabled={busyKey !== null}
            onClick={onEdit}
            data-testid="workflow-edit"
          >
            정의 수정
          </button>
          {confirmDelete ? (
            <button
              className="ghost danger-button"
              type="button"
              disabled={busyKey !== null}
              onClick={() =>
                reportAsync(removeWorkflow(false), (failure) => setError(String(failure)))
              }
              data-testid="workflow-delete-confirm"
            >
              삭제 확인
            </button>
          ) : (
            <button
              className="ghost danger-button"
              type="button"
              disabled={busyKey !== null}
              onClick={() => setConfirmDelete(true)}
              data-testid="workflow-delete"
            >
              워크플로 삭제
            </button>
          )}
        </div>
        {confirmDelete ? (
          <p className="run-meta">
            정의를 삭제합니다. 연결된 스케줄이 있으면 서버가 삭제를 거부합니다. 실행 기록은
            보존됩니다.
          </p>
        ) : null}
        {deleteConflict ? (
          <button
            className="ghost danger-button"
            type="button"
            disabled={busyKey !== null}
            onClick={() =>
              reportAsync(removeWorkflow(true), (failure) => setError(String(failure)))
            }
            data-testid="workflow-cascade-delete"
          >
            연결된 스케줄도 모두 삭제
          </button>
        ) : null}
      </section>
      {error ? (
        <ErrorMessage
          title="요청을 처리하지 못했습니다. 서버 응답을 그대로 표시합니다."
          error={error}
          testId="workflow-action-error"
        />
      ) : null}
      {notice ? (
        <p className="workflow-notice" role="status">
          {notice}
        </p>
      ) : null}
      <WorkflowDefinition workflow={workflow} accounts={accounts} />
      <ScheduleSection
        schedules={schedules}
        busyKey={busyKey}
        onAdd={() => setEditor({ schedule: null, workflow })}
        onEdit={(schedule) => setEditor({ schedule, workflow })}
        onToggle={(schedule) =>
          reportAsync(
            mutate(`toggle:${schedule.id}`, async () => {
              await sendJson(
                "PATCH",
                `/api/schedules/${encodeURIComponent(schedule.id)}`,
                { enabled: !schedule.enabled },
                ScheduleBindingSchema,
              );
              return schedule.enabled
                ? "스케줄을 일시정지했습니다."
                : "스케줄 자동 실행을 켰습니다.";
            }),
            (failure) => setError(String(failure)),
          )
        }
        onRun={(schedule) =>
          reportAsync(
            mutate(`run:${schedule.id}`, async () => {
              const body = await postJson(
                `/api/schedules/${encodeURIComponent(schedule.id)}/run`,
                {},
                ScheduleRunResponseSchema,
              );
              return `실행 ${body.run.id}을(를) 큐에 넣었습니다. 완료된 것은 아니며 아래 기록에서 상태를 확인하세요.`;
            }),
            (failure) => setError(String(failure)),
          )
        }
        onDelete={(schedule) =>
          reportAsync(
            mutate(`delete:${schedule.id}`, async () => {
              await sendJson(
                "DELETE",
                `/api/schedules/${encodeURIComponent(schedule.id)}`,
                undefined,
                DeletedResponseSchema,
              );
              return "스케줄 연결을 삭제했습니다. 실행 기록은 보존됩니다.";
            }),
            (failure) => setError(String(failure)),
          )
        }
      />
      {editor ? (
        <ScheduleForm
          key={editor.schedule?.id ?? "new"}
          workflow={editor.workflow}
          schedule={editor.schedule}
          onCancel={() => setEditor(null)}
          onSaved={async () => {
            setEditor(null);
            setNotice("스케줄을 저장했습니다.");
            await onChanged();
          }}
        />
      ) : null}
      <WorkflowHistory runs={runs} onChanged={onChanged} />
      {runSnapshot ? (
        <RunDialog
          workflow={runSnapshot}
          onChanged={onChanged}
          onClose={() => setRunSnapshot(null)}
        />
      ) : null}
    </div>
  );
}
