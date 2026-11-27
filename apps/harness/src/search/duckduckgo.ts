import { parseDuckDuckGoHtml } from "./html";
import { requestSignal, SearchProviderError } from "./transport";
import type { FetchLike } from "./transport";
import type { SearchHit } from "./types";

export type DuckDuckGoContext = {
  readonly baseUrl: string;
  readonly fetch: FetchLike;
  readonly signal?: AbortSignal;
};

export async function searchDuckDuckGo(
  query: string,
  limit: number,
  context: DuckDuckGoContext,
): Promise<SearchHit[]> {
  const url = new URL(context.baseUrl);
  url.searchParams.set("q", query);
  const response = await context.fetch(url.toString(), {
    method: "GET",
    headers: { accept: "text/html" },
    signal: requestSignal(context.signal),
  });
  if (!response.ok) {
    const kind = response.status === 403 || response.status === 429 ? "blocked" : "http";
    throw new SearchProviderError("duckduckgo", kind, `http_${response.status}`);
  }
  const page = parseDuckDuckGoHtml(await response.text());
  if (page.blocked)
    throw new SearchProviderError("duckduckgo", "blocked", "search page was blocked");
  return page.results.slice(0, limit).map((result, index) => ({
    provider: "duckduckgo",
    title: result.title,
    url: result.url,
    snippet: result.snippet,
    position: index + 1,
  }));
}
