export { searchConfigFromEnv } from "./config";
export { createWebSearchService, SearchRequestSchema } from "./service";
export type { WebSearchService, WebSearchServiceDeps } from "./service";
export { SearchProviderError } from "./transport";
export type { CliResult, CliRunner, FetchLike } from "./transport";
export { SEARCH_PROVIDERS, SearchHitSchema } from "./types";
export type {
  ArchiveRef,
  ProviderConfig,
  ProviderFailure,
  ProviderFailureKind,
  SearchConfig,
  SearchHit,
  SearchProvider,
  SearchProviderSelection,
  SearchRequest,
  WebSearchResult,
} from "./types";
