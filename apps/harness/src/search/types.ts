import { z } from "zod";

export const SEARCH_PROVIDERS = ["tinyfish", "firecrawl", "duckduckgo"] as const;

export type SearchProvider = (typeof SEARCH_PROVIDERS)[number];
export type SearchProviderSelection = "auto" | "all" | SearchProvider;

export const SearchHitSchema = z.object({
  provider: z.enum(SEARCH_PROVIDERS),
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
  position: z.number().int().positive(),
});

export type SearchHit = z.infer<typeof SearchHitSchema>;

export type ProviderFailureKind =
  | "provider_unavailable"
  | "http"
  | "provider_error"
  | "malformed"
  | "blocked"
  | "empty_results"
  | "transport"
  | "aborted"
  | "archive_failed";

export type ProviderFailure = {
  readonly provider: string;
  readonly kind: ProviderFailureKind;
  readonly message: string;
};

export type ArchiveRef = { readonly id: string; readonly path: string };

export type WebSearchResult = {
  readonly ok: boolean;
  readonly query: string;
  readonly results: SearchHit[];
  readonly failures: ProviderFailure[];
  readonly archives: ArchiveRef[];
};

export type ProviderConfig = {
  readonly apiKey: string | null;
  readonly baseUrl: string;
  readonly cliEnabled: boolean;
};

export type SearchConfig = {
  readonly tinyfish: ProviderConfig;
  readonly firecrawl: ProviderConfig;
  readonly duckduckgo: { readonly baseUrl: string };
  readonly cliEnabled: boolean;
};

export type SearchRequest = {
  readonly query: string;
  readonly provider?: SearchProviderSelection;
  readonly limit?: number;
};
