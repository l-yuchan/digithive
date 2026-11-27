import { z } from "zod";
import {
  assertCliSuccess,
  httpUrl,
  readJson,
  requestSignal,
  SearchProviderError,
} from "./transport";
import type { ProviderContext } from "./tinyfish";
import type { SearchHit } from "./types";

const ItemSchema = z.looseObject({
  title: z.string().nullish(),
  url: z.string().nullish(),
  description: z.string().nullish(),
  snippet: z.string().nullish(),
});

const ResponseSchema = z.looseObject({
  success: z.boolean().optional(),
  data: z.looseObject({ web: z.array(ItemSchema).optional() }).optional(),
  web: z.array(ItemSchema).optional(),
  error: z.string().nullish(),
});

function hitFrom(item: z.infer<typeof ItemSchema>, index: number): SearchHit | null {
  const url = httpUrl(item.url);
  if (!url) return null;
  return {
    provider: "firecrawl",
    title: (item.title ?? "").trim() || url,
    url,
    snippet: (item.description ?? item.snippet ?? "").trim(),
    position: index + 1,
  };
}

function normalize(payload: unknown): SearchHit[] {
  const parsed = ResponseSchema.safeParse(payload);
  if (!parsed.success)
    throw new SearchProviderError("firecrawl", "malformed", "unexpected Firecrawl response");
  if (parsed.data.success === false)
    throw new SearchProviderError(
      "firecrawl",
      "provider_error",
      parsed.data.error?.trim() || "search_failed",
    );
  const web = parsed.data.data?.web ?? parsed.data.web ?? [];
  return web
    .map((item, index) => hitFrom(item, index))
    .filter((hit): hit is SearchHit => hit !== null);
}

export async function searchFirecrawl(
  query: string,
  limit: number,
  context: ProviderContext,
): Promise<SearchHit[]> {
  const signal = requestSignal(context.signal);
  if (context.config.apiKey) {
    const url = `${context.config.baseUrl.replace(/\/+$/, "")}/v2/search`;
    const response = await context.fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${context.config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, limit }),
      signal,
    });
    if (!response.ok) throw new SearchProviderError("firecrawl", "http", `http_${response.status}`);
    return normalize(await readJson(response, "firecrawl")).slice(0, limit);
  }
  if (!context.config.cliEnabled)
    throw new SearchProviderError(
      "firecrawl",
      "provider_unavailable",
      "unconfigured: FIRECRAWL_API_KEY is not set and SEARCH_ENABLE_CLI is false",
    );
  const result = await context.cli(
    ["firecrawl", "search", query, "--limit", String(limit), "--json"],
    { signal },
  );
  assertCliSuccess("firecrawl", result);
  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout);
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new SearchProviderError("firecrawl", "malformed", "cli output is not JSON");
    throw error;
  }
  return normalize(payload).slice(0, limit);
}
