import { z } from "zod";
import type { SQLQueryBindings } from "bun:sqlite";
import { enabledGoogleAccounts, getAccount, isSourceEnabled } from "../integrations/accounts";
import { accessToken, type GoogleDeps } from "../integrations/google";
import { normalizeGmail } from "../integrations/normalize";
import type { ToolRuntime } from "./registry";

type AccountTarget = { readonly id: string; readonly label: string; readonly email: string | null };

function targetAccounts(deps: GoogleDeps, accountId: string): AccountTarget[] {
  const account = getAccount(deps.db, accountId);
  if (!account || account.provider !== "google") throw new Error("account_not_found");
  return [{ id: account.id, label: account.label, email: account.email }];
}

/** Read-only personal data tools shared by conversation and background work. */
export function personalTools(deps: GoogleDeps): ToolRuntime[] {
  return [
    {
      name: "gmail_search",
      description:
        "연결된 Google 메일함을 Gmail 검색식으로 검색하고 본문을 읽습니다. 계정을 지정하지 않으면 사용 중인 모든 계정을 검색하고 결과마다 계정을 표시합니다. 뉴스레터 검색과 요약에 사용합니다. 연결 오류는 도구 결과로 확인하세요.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Gmail 검색식, 예: newer_than:7d newsletter" },
          limit: { type: "integer", minimum: 1, maximum: 10 },
          accountId: {
            type: "string",
            description: "특정 Google 계정 id. 생략하면 사용 중인 모든 계정을 검색합니다.",
          },
        },
        required: ["query"],
      },
      action: "read",
      conversation: true,
      execute: async (args, context) => {
        const input = z
          .object({
            query: z.string().max(1000),
            limit: z.number().int().min(1).max(10).default(5),
            accountId: z.string().min(1).optional(),
          })
          .parse(args);

        const accounts = input.accountId
          ? targetAccounts(deps, input.accountId)
          : enabledGoogleAccounts(deps.db, "gmail").map((account) => ({
              id: account.id,
              label: account.label,
              email: account.email,
            }));
        if (accounts.length === 0) throw new Error("google_not_connected");

        const messages: unknown[] = [];
        const errors: { accountId: string; error: string }[] = [];
        let hasMore = false;
        for (const account of accounts) {
          if (!isSourceEnabled(deps.db, account.id, "gmail")) {
            errors.push({ accountId: account.id, error: "source_disabled" });
            continue;
          }
          try {
            const token = await accessToken(deps, account.id);
            const request = async (url: string) => {
              const response = await (deps.fetchImpl ?? fetch)(url, {
                headers: { authorization: `Bearer ${token}` },
                signal: context.signal ?? AbortSignal.timeout(25_000),
              });
              if (!response.ok)
                throw new Error(`gmail_http_${response.status}: ${await response.text()}`);
              const body: unknown = await response.json();
              return body;
            };
            const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
            url.searchParams.set("q", input.query);
            url.searchParams.set("maxResults", String(input.limit));
            const list = z
              .object({
                messages: z.array(z.object({ id: z.string() })).default([]),
                nextPageToken: z.string().optional(),
              })
              .parse(await request(url.toString()));
            if (list.nextPageToken) hasMore = true;
            for (const message of list.messages) {
              const item = normalizeGmail(
                await request(
                  `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(message.id)}?format=full`,
                ),
              );
              messages.push({
                ...item,
                detail: item.detail.slice(0, 12_000),
                accountId: account.id,
                accountLabel: account.label,
                accountEmail: account.email,
              });
            }
          } catch (error) {
            // One account's token or network failure must not hide another's results.
            errors.push({
              accountId: account.id,
              error: error instanceof Error ? error.message : "gmail_failed",
            });
          }
        }
        return JSON.stringify({
          query: input.query,
          messages,
          hasMore,
          accounts: accounts.map((account) => ({
            id: account.id,
            label: account.label,
            email: account.email,
          })),
          ...(errors.length > 0 ? { errors } : {}),
        });
      },
    },
    {
      name: "personal_data_search",
      description:
        "이미 수집된 캘린더 일정, 메일, LMS 과제를 검색합니다. 결과마다 수집 계정을 표시하며 사용 중지된 소스는 검색하지 않습니다. 결과의 수집 상태와 시각을 확인하고 최신 자료가 필요하면 gmail_search를 사용합니다.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", enum: ["calendar", "gmail", "canvas"] },
          query: { type: "string" },
          accountId: {
            type: "string",
            description: "특정 계정 id. 생략하면 사용 중지되지 않은 모든 계정을 검색합니다.",
          },
        },
        required: ["source", "query"],
      },
      action: "read",
      conversation: true,
      execute: async (args) => {
        const input = z
          .object({
            source: z.enum(["calendar", "gmail", "canvas"]),
            query: z.string().max(1000),
            accountId: z.string().min(1).optional(),
          })
          .parse(args);
        if (input.accountId) {
          const account = getAccount(deps.db, input.accountId);
          if (!account) throw new Error("account_not_found");
        }
        const bindings: SQLQueryBindings[] = [input.source];
        let where =
          "si.source = ? AND s.enabled = 1 AND (instr(lower(si.title),lower(?))>0 OR instr(lower(si.detail),lower(?))>0)";
        bindings.push(input.query, input.query);
        if (input.accountId) {
          where += " AND si.account_id = ?";
          bindings.push(input.accountId);
        }
        const items = deps.db
          .query(
            `SELECT si.account_id AS accountId,
                    a.label AS accountLabel,
                    a.email AS accountEmail,
                    si.item_id, si.title, si.at, si.detail, si.url, si.updated_at
             FROM sync_items si
             JOIN account_sources s ON s.account_id = si.account_id AND s.source = si.source
             JOIN integration_accounts a ON a.id = si.account_id
             WHERE ${where}
             ORDER BY si.at DESC LIMIT 20`,
          )
          .all(...bindings);
        const stateBindings: SQLQueryBindings[] = [input.source];
        let stateSql =
          "SELECT account_id, enabled, ok, last_sync_at, last_attempt_at, error FROM account_sources WHERE source = ?";
        if (input.accountId) {
          stateSql += " AND account_id = ?";
          stateBindings.push(input.accountId);
        }
        const states = deps.db
          .query(stateSql)
          .all(...stateBindings)
          .map((raw) => {
            const row = z
              .object({
                account_id: z.string(),
                enabled: z.number(),
                ok: z.number(),
                last_sync_at: z.string().nullable(),
                last_attempt_at: z.string().nullable(),
                error: z.string().nullable(),
              })
              .parse(raw);
            return {
              accountId: row.account_id,
              enabled: row.enabled === 1,
              ok: row.ok,
              last_sync_at: row.last_sync_at,
              last_attempt_at: row.last_attempt_at,
              error: row.error,
            };
          });
        // Never pick one account's state for another; an aggregate is only
        // returned when exactly one row can answer the question.
        const state = input.accountId || states.length === 1 ? (states[0] ?? null) : null;
        return JSON.stringify({
          source: input.source,
          accountId: input.accountId ?? null,
          state,
          states,
          items,
        });
      },
    },
  ];
}
