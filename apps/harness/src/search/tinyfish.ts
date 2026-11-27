import { z } from "zod";
import {
  assertCliSuccess,
  httpUrl,
  readJson,
  requestSignal,
  SearchProviderError,
} from "./transport";
import type { FetchLike, CliRunner } from "./transport";
import type { ProviderConfig, SearchHit } from "./types";

const ItemSchema = z.looseObject({
  title: z.string().nullish(),
  url: z.string().nullish(),
  link: z.string().nullish(),
  snippet: z.string().nullish(),
  description: z.string().nullish(),
});

const ResponseSchema = z.looseObject({ results: z.array(ItemSchema) });

function hitFrom(item: z.infer<typeof ItemSchema>, index: number): SearchHit | null {
  const url = httpUrl(item.url ?? item.link);
  if (!url) return null;
  return {
    provider: "tinyfish",
    title: (item.title ?? "").trim() || url,
    url,
    snippet: (item.snippet ?? item.description ?? "").trim(),
    position: index + 1,
  };
}

function normalize(payload: unknown): SearchHit[] {
  const parsed = ResponseSchema.safeParse(payload);
  if (!parsed.success)
    throw new SearchProviderError("tinyfish", "malformed", "unexpected TinyFish response");
  return parsed.data.results
    .map((item, index) => hitFrom(item, index))
    .filter((hit): hit is SearchHit => hit !== null);
}

export type ProviderContext = {
  readonly config: ProviderConfig;
  readonly fetch: FetchLike;
  readonly cli: CliRunner;
  readonly signal?: AbortSignal;
};

export async function searchTinyFish(
  query: string,
  limit: number,
  context: ProviderContext,
): Promise<SearchHit[]> {
  const signal = requestSignal(context.signal);
  if (context.config.apiKey) {
    const url = new URL(context.config.baseUrl.replace(/\/+$/, ""));
    url.searchParams.set("query", query);
    url.searchParams.set("limit", String(limit));
    const response = await context.fetch(url.toString(), {
      method: "GET",
      headers: { "x-api-key": context.config.apiKey },
      signal,
    });
    if (!response.ok) throw new SearchProviderError("tinyfish", "http", `http_${response.status}`);
    return normalize(await readJson(response, "tinyfish")).slice(0, limit);
  }
  if (!context.config.cliEnabled)
    throw new SearchProviderError(
      "tinyfish",
      "provider_unavailable",
      "unconfigured: TINYFISH_API_KEY is not set and SEARCH_ENABLE_CLI is false",
    );
  const result = await context.cli(["tinyfish", "search", "query", query], { signal });
  assertCliSuccess("tinyfish", result);
  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout);
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new SearchProviderError("tinyfish", "malformed", "cli output is not JSON");
    throw error;
  }
  return normalize(payload).slice(0, limit);
}
