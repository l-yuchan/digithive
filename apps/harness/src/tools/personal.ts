import { z } from "zod";
import { accessToken, type GoogleDeps } from "../integrations/google";
import { normalizeGmail } from "../integrations/normalize";
import type { ToolRuntime } from "./registry";

/** Read-only personal data tools shared by conversation and background work. */
export function personalTools(deps: GoogleDeps): ToolRuntime[] {
  return [
    {
      name: "gmail_search",
      description:
        "연결된 Google 메일함을 Gmail 검색식으로 검색하고 본문을 읽습니다. 뉴스레터 검색과 요약에 사용합니다. 연결 오류는 도구 결과로 확인하세요.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Gmail 검색식, 예: newer_than:7d newsletter" },
          limit: { type: "integer", minimum: 1, maximum: 10 },
        },
        required: ["query"],
      },
      action: "read",
      execute: async (args, context) => {
        const input = z
          .object({
            query: z.string().max(1000),
            limit: z.number().int().min(1).max(10).default(5),
          })
          .parse(args);
        const token = await accessToken(deps);
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
        const messages = [];
        for (const message of list.messages) {
          const item = normalizeGmail(
            await request(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(message.id)}?format=full`,
            ),
          );
          messages.push({ ...item, detail: item.detail.slice(0, 12_000) });
        }
        return JSON.stringify({
          query: input.query,
          messages,
          hasMore: Boolean(list.nextPageToken),
        });
      },
    },
    {
      name: "personal_data_search",
      description:
        "이미 수집된 캘린더 일정, 메일, LMS 과제를 검색합니다. 결과의 수집 상태와 시각을 확인하고 최신 자료가 필요하면 gmail_search를 사용합니다.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", enum: ["calendar", "gmail", "canvas"] },
          query: { type: "string" },
        },
        required: ["source", "query"],
      },
      action: "read",
      execute: async (args) => {
        const input = z
          .object({ source: z.enum(["calendar", "gmail", "canvas"]), query: z.string().max(1000) })
          .parse(args);
        const items = deps.db
          .query(
            "SELECT item_id,title,at,detail,url,updated_at FROM sync_items WHERE source=? AND (instr(lower(title),lower(?))>0 OR instr(lower(detail),lower(?))>0) ORDER BY at DESC LIMIT 20",
          )
          .all(input.source, input.query, input.query);
        const state = deps.db
          .query("SELECT ok,last_sync_at,error FROM integration_state WHERE source=?")
          .get(input.source);
        return JSON.stringify({ source: input.source, state, items });
      },
    },
  ];
}
