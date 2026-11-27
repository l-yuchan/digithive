import type { SearchConfig } from "./types";

const DEFAULT_TINYFISH_URL = "https://api.search.tinyfish.ai";
const DEFAULT_FIRECRAWL_URL = "https://api.firecrawl.dev";
const DEFAULT_DUCKDUCKGO_URL = "https://html.duckduckgo.com/html/";

function value(env: Record<string, string | undefined>, key: string): string | undefined {
  const raw = env[key]?.trim();
  return raw ? raw : undefined;
}

function cliEnabled(env: Record<string, string | undefined>): boolean {
  const raw = value(env, "SEARCH_ENABLE_CLI")?.toLowerCase();
  if (raw === undefined) return true;
  return !["0", "false", "no", "off"].includes(raw);
}

function apiKey(env: Record<string, string | undefined>, key: string): string | null {
  return value(env, key) ?? null;
}

export function searchConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): SearchConfig {
  const cli = cliEnabled(env);
  return {
    tinyfish: {
      apiKey: apiKey(env, "TINYFISH_API_KEY"),
      baseUrl: value(env, "TINYFISH_API_URL") ?? DEFAULT_TINYFISH_URL,
      cliEnabled: cli,
    },
    firecrawl: {
      apiKey: apiKey(env, "FIRECRAWL_API_KEY"),
      baseUrl: value(env, "FIRECRAWL_API_URL") ?? DEFAULT_FIRECRAWL_URL,
      cliEnabled: cli,
    },
    duckduckgo: {
      baseUrl: value(env, "DUCKDUCKGO_HTML_URL") ?? DEFAULT_DUCKDUCKGO_URL,
    },
    cliEnabled: cli,
  };
}
