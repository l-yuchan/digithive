import { expect, test } from "bun:test";
import { createWebSearchService, searchConfigFromEnv } from "../src/search";
import { parseDuckDuckGoHtml } from "../src/search/html";
import type { CliRunner, FetchLike, SearchConfig, SearchProviderSelection } from "../src/search";
import { webSearchTools } from "../src/tools/web-search";
import type { WebSearchToolDeps } from "../src/tools/web-search";

const missingCli: CliRunner = async () => ({ exitCode: null, stdout: "", stderr: "ENOENT" });
const neverFetch: FetchLike = async () => {
  throw new Error("network must not be used");
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const search = (
  config: SearchConfig,
  fetchImpl: FetchLike,
  query: string,
  provider: SearchProviderSelection = "auto",
  limit = 5,
  cli: CliRunner = missingCli,
) => createWebSearchService({ config, fetch: fetchImpl, cli }).search({ query, provider, limit });
const onlyTool = (deps: WebSearchToolDeps) => {
  const tool = webSearchTools(deps)[0];
  if (!tool) throw new Error("web_search tool missing");
  return tool;
};
const DDG_HTML = `<!doctype html><html><body>
<div class="result results_links web-result"><h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1%26c%3D2&amp;rut=xyz">Tom &amp; Jerry &#x27;docs&#x27;</a></h2>
<a class="result__snippet" href="#">A &lt;b&gt;snippet&lt;/b&gt; &amp; more</a></div>
<div class="result results_links web-result"><h2 class="result__title"><a class="result__a" href="https://docs.example.com/x">Direct <strong>link</strong></a></h2>
<div class="result__snippet">Second &nbsp;result</div></div>
<div class="result result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=ad.example">Ad</a></div>
</body></html>`;

test("tinyfish API hits are normalized and the key stays out of the result", async () => {
  let seen: { url: string; init: RequestInit | undefined } | undefined;
  const result = await search(
    searchConfigFromEnv({ TINYFISH_API_KEY: "tf-secret" }),
    async (url, init) => {
      seen = { url, init };
      return json({
        page: 1,
        results: [
          { title: "Docs", url: "https://example.com/docs", snippet: "API docs" },
          { title: "", link: "https://example.com/b", description: "second" },
        ],
      });
    },
    "OpenAI API docs",
    "tinyfish",
    2,
  );
  expect(seen?.url).toContain("query=OpenAI+API+docs");
  expect(seen?.url).toContain("limit=2");
  expect(new Headers(seen?.init?.headers).get("x-api-key")).toBe("tf-secret");
  expect(result.results.map((hit) => [hit.provider, hit.title, hit.url, hit.position])).toEqual([
    ["tinyfish", "Docs", "https://example.com/docs", 1],
    ["tinyfish", "https://example.com/b", "https://example.com/b", 2],
  ]);
  expect(JSON.stringify(result)).not.toContain("tf-secret");
  expect(result.archives).toEqual([]);
});

test("tinyfish CLI fallback parses JSON and a missing or nonzero CLI is provider_unavailable", async () => {
  const calls: string[][] = [];
  const cli: CliRunner = async (cmd) => {
    calls.push([...cmd]);
    return {
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({ results: [{ url: "https://e.com" }] }),
    };
  };
  const ok = await search(searchConfigFromEnv({}), neverFetch, "q", "tinyfish", 5, cli);
  expect(calls[0]).toEqual(["tinyfish", "search", "query", "q"]);
  expect(ok.results[0]).toMatchObject({ provider: "tinyfish", url: "https://e.com/", position: 1 });
  const missing = await search(searchConfigFromEnv({}), neverFetch, "q", "tinyfish");
  expect(missing.failures[0]).toMatchObject({ provider: "tinyfish", kind: "provider_unavailable" });
  const denied: CliRunner = async () => ({ exitCode: 2, stdout: "", stderr: "denied" });
  const nonzero = await search(searchConfigFromEnv({}), neverFetch, "q", "tinyfish", 5, denied);
  expect(nonzero.failures[0]?.message).toContain("cli_exit_2");
});

test("firecrawl REST uses bearer auth and both data.web and SDK web shapes", async () => {
  let seen: { url: string; init: RequestInit | undefined } | undefined;
  const config = searchConfigFromEnv({ FIRECRAWL_API_KEY: "fc-secret" });
  const result = await search(
    config,
    async (url, init) => {
      seen = { url, init };
      return json({ success: true, data: { web: [{ title: "F", url: "https://f.com/1" }] } });
    },
    "openai",
    "firecrawl",
    3,
  );
  expect(seen?.url).toBe("https://api.firecrawl.dev/v2/search");
  expect(seen?.init?.method).toBe("POST");
  expect(new Headers(seen?.init?.headers).get("authorization")).toBe("Bearer fc-secret");
  expect(seen?.init?.body).toBe(JSON.stringify({ query: "openai", limit: 3 }));
  expect(result.results[0]).toMatchObject({ provider: "firecrawl", url: "https://f.com/1" });
  const sdk = await search(
    config,
    async () => json({ success: true, web: [{ url: "https://sdk.example" }] }),
    "openai",
    "firecrawl",
  );
  expect(sdk.results[0]?.url).toBe("https://sdk.example/");
});

test("http, malformed, empty and provider errors keep provider and kind", async () => {
  const config = searchConfigFromEnv({ FIRECRAWL_API_KEY: "k" });
  const cases: [Response, string][] = [
    [new Response("boom", { status: 500 }), "http"],
    [json({ data: { web: "nope" } }), "malformed"],
    [json({ success: false, error: "plan limit" }), "provider_error"],
    [json({ success: true, data: { web: [] } }), "empty_results"],
  ];
  for (const [body, kind] of cases) {
    const result = await search(config, async () => body, "q", "firecrawl");
    expect(result.failures[0]).toMatchObject({ provider: "firecrawl", kind });
  }
});

test("auto falls back to hits and retains earlier failures", async () => {
  const result = await search(
    searchConfigFromEnv({ TINYFISH_API_KEY: "t", FIRECRAWL_API_KEY: "f" }),
    async (url) => {
      if (url.includes("api.search.tinyfish.ai")) return new Response("down", { status: 500 });
      if (url.includes("api.firecrawl.dev")) return json({ success: false, error: "quota" });
      return new Response(DDG_HTML);
    },
    "docs",
  );
  expect(result.results.map((hit) => hit.provider)).toEqual(["duckduckgo", "duckduckgo"]);
  expect(result.failures.map((failure) => [failure.provider, failure.kind])).toEqual([
    ["tinyfish", "http"],
    ["firecrawl", "provider_error"],
  ]);
});

test("all queries every provider and keeps per-provider hits beside one failure", async () => {
  const result = await search(
    searchConfigFromEnv({ TINYFISH_API_KEY: "t", FIRECRAWL_API_KEY: "f" }),
    async (url) => {
      if (url.includes("tinyfish")) return json({ results: [{ url: "https://t.example" }] });
      if (url.includes("firecrawl")) return new Response("bad", { status: 400 });
      return new Response(DDG_HTML);
    },
    "docs",
    "all",
  );
  expect(result.results.map((hit) => hit.provider)).toEqual([
    "tinyfish",
    "duckduckgo",
    "duckduckgo",
  ]);
  expect(result.failures).toEqual([{ provider: "firecrawl", kind: "http", message: "http_400" }]);
});

test("no hits and no configured providers is a visible failure", async () => {
  const result = await search(
    searchConfigFromEnv({ SEARCH_ENABLE_CLI: "false" }),
    async () => new Response("<html><body>No results</body></html>"),
    "nothing",
  );
  expect(result.ok).toBe(false);
  expect(result.results).toEqual([]);
  expect(result.failures.map((failure) => [failure.provider, failure.kind])).toEqual([
    ["tinyfish", "provider_unavailable"],
    ["firecrawl", "provider_unavailable"],
    ["duckduckgo", "empty_results"],
  ]);
});

test("duckduckgo decodes uddg targets and entities and skips ads", () => {
  const page = parseDuckDuckGoHtml(DDG_HTML);
  expect(page.blocked).toBe(false);
  expect(page.results).toEqual([
    {
      title: "Tom & Jerry 'docs'",
      url: "https://example.com/a?b=1&c=2",
      snippet: "A snippet & more",
    },
    { title: "Direct link", url: "https://docs.example.com/x", snippet: "Second result" },
  ]);
});

test("duckduckgo 403, block page and zero parses are failures", async () => {
  const cases: [Response, string][] = [
    [new Response("no", { status: 403 }), "blocked"],
    [new Response("<html>unusual traffic anomaly</html>"), "blocked"],
    [new Response("<html><body>nothing</body></html>"), "empty_results"],
  ];
  for (const [body, kind] of cases) {
    const result = await search(searchConfigFromEnv({}), async () => body, "q", "duckduckgo");
    expect(result.failures[0]).toMatchObject({ provider: "duckduckgo", kind });
  }
});

test("an aborted signal never calls a provider", async () => {
  let calls = 0;
  const result = await createWebSearchService({
    config: searchConfigFromEnv({ TINYFISH_API_KEY: "t" }),
    fetch: async () => {
      calls++;
      return json({ results: [] });
    },
    signal: AbortSignal.abort(),
  }).search({ query: "q", provider: "all" });
  expect(calls).toBe(0);
  expect(result.failures.map((failure) => failure.kind)).toEqual(["aborted", "aborted", "aborted"]);
});

test("the web_search tool archives hits and keeps archive failures visible", async () => {
  const config = searchConfigFromEnv({ TINYFISH_API_KEY: "t" });
  const fetchImpl: FetchLike = async () =>
    json({ results: [{ title: "T", url: "https://e.com" }] });
  let archived: { query: string; hits: readonly unknown[] } | undefined;
  const archive = async (query: string, hits: readonly unknown[]) => {
    archived = { query, hits };
    return [{ id: "wb_1", path: "records/web/1.md" }];
  };
  const delivered = await onlyTool({ config, fetch: fetchImpl, archive }).execute(
    { query: "docs", provider: "tinyfish" },
    { runId: "r" },
  );
  expect(archived?.query).toBe("docs");
  expect(archived?.hits).toHaveLength(1);
  expect(JSON.parse(delivered)).toMatchObject({
    ok: true,
    archives: [{ id: "wb_1", path: "records/web/1.md" }],
  });
  const failing = onlyTool({
    config,
    fetch: fetchImpl,
    archive: async () => {
      throw new Error("disk_full");
    },
  });
  const failed = await failing.execute({ query: "docs", provider: "tinyfish" }, { runId: "r" });
  expect(JSON.parse(failed)).toMatchObject({
    ok: false,
    archives: [],
    failures: [{ provider: "archive", kind: "archive_failed", message: "disk_full" }],
  });
});

test("tool args are zod-strict and config parses CLI and base URL envs", async () => {
  const tool = onlyTool({ config: searchConfigFromEnv({}), archive: () => [] });
  await expect(tool.execute({ query: "q", extra: true }, { runId: "r" })).rejects.toThrow();
  const config = searchConfigFromEnv({
    SEARCH_ENABLE_CLI: "false",
    TINYFISH_API_URL: "https://tiny.test",
    FIRECRAWL_API_URL: "https://fc.test/",
    DUCKDUCKGO_HTML_URL: "https://ddg.test/html/",
  });
  expect(config.tinyfish.cliEnabled).toBe(false);
  expect(config.tinyfish.apiKey).toBeNull();
  expect(config.firecrawl.baseUrl).toBe("https://fc.test/");
  expect(searchConfigFromEnv({}).duckduckgo.baseUrl).toBe("https://html.duckduckgo.com/html/");
});
