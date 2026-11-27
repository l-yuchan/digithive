import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { EventLog } from "../events/log";
import type { SourceName } from "../integrations/accounts";
import { isSourceEnabled } from "../integrations/accounts";
import { collectSources } from "../integrations/sync";
import type { CanvasDeps } from "../integrations/canvas";
import type { GoogleDeps } from "../integrations/google";
import { composeStoredBriefing } from "../jobs/briefing";
import type { ToolRuntime } from "./registry";
import type { PushConfig } from "../scheduler/push";
import { pushConfigured, sendPush } from "../scheduler/push";
import { storeAgentBriefing } from "../workflows/briefing-store";
import type { WhiteboardEvidence } from "./whiteboard-evidence";

export type JobToolDeps = {
  readonly db: Database;
  readonly events: EventLog;
  /** The full sync configuration; a script job reads one source at a time. */
  readonly google: GoogleDeps;
  readonly canvas: CanvasDeps;
  /** Absent while no VAPID pair is configured; a job then reports no device. */
  readonly push?: PushConfig;
  /** Agent briefing retrieval receipts and the canonical filesystem refresh. */
  readonly briefingSources?: WhiteboardEvidence;
  readonly refreshWhiteboard?: () => void;
};

export class BriefingToolError extends Error {
  readonly name = "BriefingToolError";

  constructor(readonly code: "briefing_evidence_unavailable") {
    super(code);
  }
}

export type JobAccount = {
  readonly id: string;
  readonly provider: string;
  readonly label: string;
  readonly email: string | null;
  readonly connected: boolean;
  /** Only the sources the owner has left on: a disabled feature is not used. */
  readonly sources: readonly SourceName[];
};

/**
 * What the app's own scripts reach that the model never does: the account list
 * with its feature switches, and the push path. They are ordinary tools with
 * their own capabilities, so a script is granted them like any other.
 */
export function jobTools(deps: JobToolDeps): ToolRuntime[] {
  return [
    {
      name: "account_list",
      description:
        "연결된 계정과 계정별로 사용 중인 정보(켜진 소스)를 나열합니다. 꺼진 소스는 목록에 없습니다. 작업 스크립트가 무엇을 읽을지 고를 때 사용합니다.",
      parameters: {
        type: "object",
        properties: {
          accountId: { type: "string", description: "특정 계정 id. 생략하면 모든 계정." },
        },
      },
      action: "read",
      execute: async (args) => {
        const input = z.object({ accountId: z.string().min(1).optional() }).parse(args);
        return JSON.stringify({ accounts: listJobAccounts(deps.db, input.accountId) });
      },
    },
    {
      name: "source_collect",
      description:
        "계정의 한 출처를 증분 수집하고 결과를 돌려줍니다. 기능이 꺼진 출처는 수집하지 않습니다.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", enum: ["calendar", "gmail", "canvas"] },
          accountId: { type: "string" },
        },
        required: ["source", "accountId"],
      },
      action: "read",
      execute: async (args, context) => {
        const input = z
          .object({
            source: z.enum(["calendar", "gmail", "canvas"]),
            accountId: z.string().min(1),
          })
          .parse(args);
        if (!isSourceEnabled(deps.db, input.accountId, input.source))
          return JSON.stringify({
            source: input.source,
            ok: false,
            error: "source_disabled",
            note: "이 정보의 사용이 꺼져 있어 수집하지 않았습니다.",
          });
        const scoped = (implementation: typeof fetch): typeof fetch =>
          Object.assign(
            (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
              implementation(url, {
                ...init,
                ...(context.signal ? { signal: context.signal } : {}),
              }),
            { preconnect: implementation.preconnect },
          );
        const [outcome] = await collectSources(
          {
            google: { ...deps.google, fetchImpl: scoped(deps.google.fetchImpl ?? fetch) },
            canvas: { ...deps.canvas, fetchImpl: scoped(deps.canvas.fetchImpl ?? fetch) },
          },
          { accountId: input.accountId, sources: [input.source] },
        );
        return JSON.stringify(outcome ?? { source: input.source, ok: false, error: "no_outcome" });
      },
    },
    {
      name: "briefing_compose",
      description:
        "지금 시각의 브리핑을 만들어 저장하고, 알림에 보낼 제목과 본문을 돌려줍니다. 알림 발송은 push_send가 합니다.",
      parameters: { type: "object", properties: {} },
      action: "edit",
      execute: async (_args, context) =>
        JSON.stringify(
          await composeStoredBriefing({
            db: deps.db,
            events: deps.events,
            // A briefing row links the run that made it, so the link is only written
            // when that run row exists (a script run always does; a bare tool probe
            // from a test or a script started outside the queue may not).
            runId: runExists(deps.db, context.runId) ? context.runId : null,
            now: Date.now(),
          }),
        ),
    },
    {
      name: "briefing_publish",
      description:
        "화이트보드에서 실제 읽은 출처를 근거로, 에이전트가 작성한 브리핑을 실행과 연결해 저장합니다. 반환된 제목과 본문으로 push_send를 호출하세요.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "에이전트가 작성한 자연어 브리핑 전문" },
          sourceIds: {
            type: "array",
            items: { type: "string" },
            description: "같은 실행에서 whiteboard_list/read가 반환한 문서 id",
          },
          slot: { type: "string", description: "생략하면 현재 한국 시각 HH:mm" },
        },
        required: ["text", "sourceIds"],
      },
      action: "edit",
      execute: async (args, context) => {
        const input = z
          .object({
            text: z.string().trim().min(1).max(60_000),
            sourceIds: z.array(z.string().min(1)).min(1).max(100),
            slot: z.string().min(1).max(32).optional(),
          })
          .strict()
          .parse(args);
        if (!deps.briefingSources) throw new BriefingToolError("briefing_evidence_unavailable");
        deps.briefingSources.assertRetrieved(context.runId, input.sourceIds);
        const result = storeAgentBriefing({
          db: deps.db,
          events: deps.events,
          runId: context.runId,
          text: input.text,
          sourceIds: input.sourceIds,
          ...(input.slot === undefined ? {} : { slot: input.slot }),
          now: Date.now(),
        });
        if (!result.duplicate) deps.refreshWhiteboard?.();
        return JSON.stringify({ ...result, stored: !result.duplicate });
      },
    },
    {
      name: "push_send",
      description:
        "등록된 기기로 푸시 알림을 보냅니다. 도달한 기기가 없어도 실패가 아니며 sent 0으로 돌아옵니다.",
      parameters: {
        type: "object",
        properties: { title: { type: "string" }, body: { type: "string" } },
        required: ["title", "body"],
      },
      action: "read",
      execute: async (args) => {
        const input = z
          .object({ title: z.string().min(1).max(200), body: z.string().min(1).max(1_000) })
          .parse(args);
        if (!deps.push || !pushConfigured(deps.push))
          return JSON.stringify({ sent: 0, failed: 0, errors: ["push_unconfigured"] });
        return JSON.stringify(await sendPush(deps.db, deps.push, input));
      },
    },
  ];
}

/** True when the run a script is acting for has a row; a briefing links only such a run. */
function runExists(db: Database, runId: string): boolean {
  return db.query<{ id: string }, [string]>("SELECT id FROM runs WHERE id = ?").get(runId) !== null;
}

export function listJobAccounts(db: Database, accountId?: string): JobAccount[] {
  const accounts = db
    .query<{ id: string; provider: string; label: string; email: string | null }, [string] | []>(
      accountId === undefined
        ? "SELECT id,provider,label,email FROM integration_accounts ORDER BY provider, created_at, id"
        : "SELECT id,provider,label,email FROM integration_accounts WHERE id = ?",
    )
    .all(...(accountId === undefined ? [] : ([accountId] as [string])));
  const tokens = new Set(
    db
      .query<{ account_id: string }, []>("SELECT account_id FROM oauth_tokens")
      .all()
      .map((row) => row.account_id),
  );
  return accounts.map((account) => ({
    id: account.id,
    provider: account.provider,
    label: account.label,
    email: account.email,
    connected: account.provider === "google" ? tokens.has(account.id) : true,
    sources: db
      .query<{ source: SourceName }, [string]>(
        "SELECT source FROM account_sources WHERE account_id = ? AND enabled = 1 ORDER BY source",
      )
      .all(account.id)
      .map((row) => row.source),
  }));
}
