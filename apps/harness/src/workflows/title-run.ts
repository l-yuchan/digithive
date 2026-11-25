import type { Database } from "bun:sqlite";
import type { EventLog } from "../events/log";
import type { SettleHooks } from "../surfaces/work/settle";
import type { RunRow } from "../surfaces/work/record";
import { enqueueWorkflowRun } from "./workflow-run";
import { executeRun, getRun, type WorkDeps } from "../surfaces/work/runner";
import { getWorkflow } from "./workflow-store";
import { applyAutoTitle, getSession, listEntries } from "../core/sessions";
import { materialOf } from "../surfaces/conversation/surface";
import { parseTitle, TITLE_INSTRUCTION, TITLE_WORKFLOW_KEY, titleMaterial } from "./title";

/**
 * Naming a conversation from its first turn.
 *
 * The name is produced by an ordinary workflow run (`agent` executor) that the app
 * owns, so it appears in the execution log like any other work instead of being an
 * invisible background call. The run carries the conversation id as a parameter, and
 * the agent executor reads that conversation's first question and answer as its
 * material, so one definition serves every conversation.
 *
 * The rules that keep it safe:
 * - one attempt per conversation: it starts once the first answer is stored, and a
 *   conversation that already has a name is never named again;
 * - a name the owner typed is never touched (`title_source` stays `user`);
 * - a failure is reported as `session.title_failed` and leaves the default name,
 *   rather than retrying on every turn.
 */
export type TitleDeps = {
  readonly db: Database;
  readonly events: EventLog;
  /** Told when a title run ended, either way, so the conversation can carry on. */
  readonly onSettled?: (sessionId: string) => void;
};

export const TITLE_RUN_TIMEOUT_SECONDS = 60;
const NL = String.fromCharCode(10);

/** Creates the app's title workflow when it is missing; returns its definition. */
export function ensureTitleWorkflow(deps: TitleDeps): { id: string } {
  const existing = getWorkflow(deps.db, TITLE_WORKFLOW_KEY);
  if (existing) return existing;
  const now = new Date().toISOString();
  deps.db
    .query(
      `INSERT INTO workflows (id, title, instruction, executor_json, params_json, timeout_seconds, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      TITLE_WORKFLOW_KEY,
      "대화 이름 짓기",
      TITLE_INSTRUCTION,
      JSON.stringify({ kind: "agent" }),
      JSON.stringify([
        {
          name: "conversation",
          type: "string",
          required: true,
          description: "이름을 붙일 대화 id",
        },
      ]),
      TITLE_RUN_TIMEOUT_SECONDS,
      now,
      now,
    );
  const inserted = getWorkflow(deps.db, TITLE_WORKFLOW_KEY);
  if (!inserted) throw new Error(`title workflow insert failed: ${TITLE_WORKFLOW_KEY}`);
  return inserted;
}

/** True when this conversation has exactly one finished answer and still has its default name. */
export function shouldName(db: Database, sessionId: string): boolean {
  const session = getSession(db, sessionId);
  if (!session || session.titleSource !== "initial") return false;
  const messages = listEntries(db, sessionId).filter((entry) => entry.kind === "message");
  const answers = messages.filter(
    (entry) => entry.role === "assistant" && entry.status === "complete",
  );
  const asked = messages.filter((entry) => entry.role === "user");
  return asked.length === 1 && answers.length === 1;
}

/** True while a title run for this conversation is queued or running. */
export function titleRunInFlight(db: Database, sessionId: string): boolean {
  const row = db
    .query<{ live: number }, [string, string]>(
      "SELECT COUNT(*) AS live FROM runs WHERE session_id = ? AND workflow_id = ? AND status IN ('queued','running','awaiting_approval')",
    )
    .get(sessionId, TITLE_WORKFLOW_KEY);
  return (row?.live ?? 0) > 0;
}

/**
 * Starts the title run for a conversation; null when it should not run.
 *
 * It runs inline in the server process, the same way the workflow tool runs a
 * workflow: work runs are executed by the separate worker, and a naming run queued
 * for a worker that is not running would hold the conversation queue open behind a
 * step nobody asked for. A run's goal is its first message, so the material travels
 * as the goal rather than as a parameter every conversation would have to fill.
 */
export function startTitleRun(deps: TitleDeps, work: WorkDeps, sessionId: string): boolean {
  if (!shouldName(deps.db, sessionId)) return false;
  const workflow = ensureTitleWorkflow(deps);
  const material = titleMaterial(materialOf(listEntries(deps.db, sessionId)));
  const goal =
    material.length > 0 ? `${TITLE_INSTRUCTION}${NL}${NL}자료:${NL}${material}` : TITLE_INSTRUCTION;
  const prepared = enqueueWorkflowRun(deps, workflow.id, {
    args: { conversation: sessionId },
    sessionId,
    triggerKind: "tool",
    goal,
  });
  const now = Date.now();
  const budgetMs = Math.min(
    prepared.workflow.timeoutSeconds * 1_000,
    work.limits?.totalMs ?? 30 * 60_000,
  );
  const owner = `title-${crypto.randomUUID()}`;
  work.db
    .query(
      "UPDATE runs SET status='running', lease_owner=?, lease_expires_at=?, attempt=attempt+1 WHERE id=? AND status='queued'",
    )
    .run(
      owner,
      new Date(now + Math.min(budgetMs, work.leaseMs ?? 45_000)).toISOString(),
      prepared.run.id,
    );
  work.events.append({
    kind: "run.started",
    runId: prepared.run.id,
    sessionId,
    payload: { owner, inline: true },
    now,
  });
  const started = getRun(work.db, prepared.run.id);
  if (!started) return true;
  void executeRun(work, started, { totalMs: budgetMs }).catch((error: unknown) => {
    // The settle path already reports a failed run; this only keeps the rejection in
    // the log instead of unhandled.
    console.error("title run failed", error);
  });
  return true;
}

/** The settle hook: a finished or failed title run writes a name or says why it did not. */
/** A naming run that has not settled by this point no longer holds the queue. */
export const TITLE_GUARD_MS = 90_000;

export function titleHooks(deps: TitleDeps): SettleHooks {
  /** Writes the name, or records why there is none. Never throws into the run's settlement. */
  const settleTitle = (
    sessionId: string,
    status: string,
    payload: Record<string, unknown>,
  ): void => {
    if (status === "succeeded") {
      const text = typeof payload["text"] === "string" ? payload["text"] : "";
      const title = parseTitle(text);
      if (title === null) {
        deps.events.append({
          kind: "session.title_failed",
          sessionId,
          payload: { reason: "unusable_reply", reply: text.slice(0, 200) },
        });
        return;
      }
      if (!applyAutoTitle(deps.db, sessionId, title)) return;
      deps.events.append({
        kind: "session.renamed",
        sessionId,
        payload: { title, by: "auto" },
      });
      return;
    }
    deps.events.append({
      kind: "session.title_failed",
      sessionId,
      payload: { reason: status, detail: payload["error"] ?? null },
    });
  };

  return {
    onSettled: (run: RunRow, status, payload) => {
      if (run.workflowId !== TITLE_WORKFLOW_KEY || run.sessionId === null) return;
      const sessionId = run.sessionId;
      deps.events.append({
        kind: "session.title_settled",
        runId: run.id,
        sessionId,
        payload: { status },
      });
      try {
        settleTitle(sessionId, status, payload);
      } finally {
        deps.onSettled?.(sessionId);
      }
    },
  };
}
