import { z } from "zod";
import { createWebSearchService } from "../search";
import type { ArchiveRef, CliRunner, FetchLike, SearchConfig, SearchHit } from "../search";
import type { ToolRuntime } from "./registry";

const ArgsSchema = z
  .object({
    query: z.string().trim().min(1).max(500),
    provider: z.enum(["auto", "all", "tinyfish", "firecrawl", "duckduckgo"]).default("auto"),
    limit: z.number().int().min(1).max(20).default(5),
  })
  .strict();

const ArchivedSchema = z.array(
  z.object({ id: z.string().min(1), path: z.string().min(1) }).strict(),
);

export type WebSearchArchive = (
  query: string,
  hits: readonly SearchHit[],
) => Promise<readonly ArchiveRef[]> | readonly ArchiveRef[];

export type WebSearchToolDeps = {
  readonly config: SearchConfig;
  readonly archive: WebSearchArchive;
  readonly fetch?: FetchLike;
  readonly cli?: CliRunner;
  readonly signal?: AbortSignal;
};

const DESCRIPTION =
  "웹을 검색합니다. provider auto는 첫 결과가 나오는 제공자를 쓰고 실패를 모두 남기며, all은 모든 제공자를 조회합니다. 결과의 archives는 원문을 남긴 화이트보드 기록입니다. failures가 있으면 검색이 일부 또는 전부 실패한 것이므로 성공으로 설명하지 마세요.";

export function webSearchTools(deps: WebSearchToolDeps): ToolRuntime[] {
  const service = createWebSearchService({
    config: deps.config,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.cli ? { cli: deps.cli } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  return [
    {
      name: "web_search",
      description: DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, maxLength: 500 },
          provider: {
            type: "string",
            enum: ["auto", "all", "tinyfish", "firecrawl", "duckduckgo"],
          },
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
        required: ["query"],
        additionalProperties: false,
      },
      action: "read",
      conversation: true,
      execute: async (args, _context) => {
        const input = ArgsSchema.parse(args);
        const outcome = await service.search({
          query: input.query,
          provider: input.provider,
          limit: input.limit,
        });
        if (!outcome.ok) return JSON.stringify(outcome);
        try {
          const refs = ArchivedSchema.parse(await deps.archive(outcome.query, outcome.results));
          return JSON.stringify({ ...outcome, archives: refs });
        } catch (error) {
          return JSON.stringify({
            ...outcome,
            ok: false,
            archives: [],
            failures: [
              ...outcome.failures,
              {
                provider: "archive",
                kind: "archive_failed",
                message: error instanceof Error ? error.message : "archive failed",
              },
            ],
          });
        }
      },
    },
  ];
}
