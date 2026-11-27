import { z } from "zod";
import { searchDuckDuckGo } from "./duckduckgo";
import { searchFirecrawl } from "./firecrawl";
import { searchTinyFish } from "./tinyfish";
import { defaultCliRunner, failureOf } from "./transport";
import type { CliRunner, FetchLike } from "./transport";
import { SEARCH_PROVIDERS } from "./types";
import type {
  ProviderFailure,
  SearchConfig,
  SearchHit,
  SearchProvider,
  SearchRequest,
  WebSearchResult,
} from "./types";

export const SearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(500),
  provider: z.enum(["auto", "all", ...SEARCH_PROVIDERS]).default("auto"),
  limit: z.number().int().min(1).max(20).default(5),
});

export type WebSearchServiceDeps = {
  readonly config: SearchConfig;
  readonly fetch?: FetchLike;
  readonly cli?: CliRunner;
  readonly signal?: AbortSignal;
};

export type WebSearchService = {
  search(input: SearchRequest): Promise<WebSearchResult>;
};

type Call = {
  readonly hits: SearchHit[];
  readonly failure: ProviderFailure | null;
};

type RunContext = {
  readonly config: SearchConfig;
  readonly fetch: FetchLike;
  readonly cli: CliRunner;
  readonly signal: AbortSignal | undefined;
};

function adapterFor(
  provider: SearchProvider,
  query: string,
  limit: number,
  context: RunContext,
): Promise<SearchHit[]> {
  switch (provider) {
    case "tinyfish":
      return searchTinyFish(query, limit, {
        config: context.config.tinyfish,
        fetch: context.fetch,
        cli: context.cli,
        ...(context.signal ? { signal: context.signal } : {}),
      });
    case "firecrawl":
      return searchFirecrawl(query, limit, {
        config: context.config.firecrawl,
        fetch: context.fetch,
        cli: context.cli,
        ...(context.signal ? { signal: context.signal } : {}),
      });
    case "duckduckgo":
      return searchDuckDuckGo(query, limit, {
        baseUrl: context.config.duckduckgo.baseUrl,
        fetch: context.fetch,
        ...(context.signal ? { signal: context.signal } : {}),
      });
    default: {
      const exhaustive: never = provider;
      throw new Error(`unknown provider: ${String(exhaustive)}`);
    }
  }
}

async function runProvider(
  provider: SearchProvider,
  query: string,
  limit: number,
  context: RunContext,
): Promise<Call> {
  if (context.signal?.aborted)
    return { hits: [], failure: { provider, kind: "aborted", message: "aborted" } };
  try {
    const hits = await adapterFor(provider, query, limit, context);
    if (context.signal?.aborted)
      return { hits: [], failure: { provider, kind: "aborted", message: "aborted" } };
    return hits.length > 0
      ? { hits, failure: null }
      : {
          hits: [],
          failure: { provider, kind: "empty_results", message: "provider returned no results" },
        };
  } catch (error) {
    return { hits: [], failure: failureOf(provider, error) };
  }
}

function toResult(query: string, calls: readonly Call[]): WebSearchResult {
  const results = calls.flatMap((call) => call.hits);
  const failures = calls.flatMap((call) => (call.failure ? [call.failure] : []));
  return { ok: results.length > 0, query, results, failures, archives: [] };
}

export function createWebSearchService(deps: WebSearchServiceDeps): WebSearchService {
  const fetchImpl: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));
  const context: RunContext = {
    config: deps.config,
    fetch: fetchImpl,
    cli: deps.cli ?? defaultCliRunner,
    signal: deps.signal,
  };
  return {
    search: async (request) => {
      const input = SearchRequestSchema.parse(request);
      if (input.provider === "all") {
        const calls = await Promise.all(
          SEARCH_PROVIDERS.map((provider) =>
            runProvider(provider, input.query, input.limit, context),
          ),
        );
        return toResult(input.query, calls);
      }
      if (input.provider !== "auto") {
        return toResult(input.query, [
          await runProvider(input.provider, input.query, input.limit, context),
        ]);
      }
      const calls: Call[] = [];
      for (const provider of SEARCH_PROVIDERS) {
        const call = await runProvider(provider, input.query, input.limit, context);
        calls.push(call);
        if (call.hits.length > 0) break;
      }
      return toResult(input.query, calls);
    },
  };
}
