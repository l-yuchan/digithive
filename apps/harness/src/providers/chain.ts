import type { StreamFn } from "./openai";
import { buildRouterRoutes, routeNameOf, type ResolvedRoute } from "./routes";
import type { ProviderStore, SeedProvider } from "./store";
import {
  createRoutingStream,
  type ProviderDiagnostic,
  type ProviderRouteConfig,
  type RouterOptions,
} from "./router";
import type { ModelRouteSummary } from "./settings";

/** What the old environment configuration said, before providers were rows. */
export type EnvModelConfig = {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly fallbacks: readonly ProviderRouteConfig[];
  readonly cooldownMs: number;
  readonly retries: number;
};

/**
 * The first run on a database that has no provider yet takes the environment's model
 * configuration as its own, so an existing deployment keeps exactly the routes it had
 * while every later change is made on the settings screen. A database that already has
 * providers is never touched by the environment again.
 */
export function seedProvidersFromEnv(store: ProviderStore, env: EnvModelConfig): number {
  const entries: SeedProvider[] = [
    {
      catalogId: "custom",
      label: env.model,
      baseUrl: env.baseUrl,
      apiKey: env.apiKey,
      headers: env.headers,
      model: env.model,
      position: 0,
    },
    ...env.fallbacks.map((fallback, index) => ({
      catalogId: "custom",
      label: fallback.model,
      baseUrl: fallback.baseUrl,
      apiKey: fallback.apiKey,
      headers: fallback.headers ?? {},
      model: fallback.model,
      position: index + 1,
    })),
  ];
  return store.seed(entries);
}

function resolvedChain(store: ProviderStore): ResolvedRoute[] {
  return store.routes().map((entry) => ({
    position: entry.position,
    providerId: entry.providerId,
    providerLabel: entry.providerLabel,
    modelId: entry.modelId,
    baseUrl: entry.baseUrl,
    apiKey: store.keyOf(entry.providerId) ?? "",
  }));
}

/** The route names in chain order, read fresh so a saved change applies to the next call. */
export function chainPriority(store: ProviderStore): string[] {
  return resolvedChain(store).map((route) => routeNameOf(route));
}

/** The public catalogue for the settings screen, built from the chain it serves. */
export function chainCatalog(store: ProviderStore): ModelRouteSummary[] {
  return resolvedChain(store).map((entry) => ({
    name: routeNameOf(entry),
    model: entry.modelId,
    baseUrl: entry.baseUrl,
  }));
}

/**
 * A routing stream over the saved chain. The priority is a function read on every model
 * call (the router already supports that), so adding, removing or reordering a provider
 * applies to the next call in this process and in the worker without a restart. The
 * routes themselves are read once per stream: the runtime builds a new one when the
 * chain changes.
 */
export function createChainStream(
  store: ProviderStore,
  options: {
    readonly cooldownMs: number;
    readonly retries: number;
    readonly usageProbe?: RouterOptions["usageProbe"];
    readonly onDiagnostic?: (diagnostic: ProviderDiagnostic) => void;
  },
): StreamFn & {
  readonly diagnostics: () => readonly ProviderDiagnostic[];
  readonly activeRoute: (contextKey: string) => string | null;
} {
  const routes = buildRouterRoutes(resolvedChain(store));
  return createRoutingStream(
    { primary: routes[0] ?? emptyRoute(), fallbacks: routes.slice(1) },
    {
      cooldownMs: options.cooldownMs,
      retries: options.retries,
      priority: () => chainPriority(store),
      // Read on every call, so a provider added, switched off or deleted on the settings
      // screen answers (or stops answering) immediately, in this process and in the worker.
      routes: () => buildRouterRoutes(resolvedChain(store)),
      ...(options.usageProbe === undefined ? {} : { usageProbe: options.usageProbe }),
      ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
    },
  );
}

function emptyRoute(): ProviderRouteConfig {
  return { name: "none", baseUrl: "http://127.0.0.1:1/v1", apiKey: "", model: "none" };
}
