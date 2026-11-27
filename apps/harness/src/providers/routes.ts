import type { ProviderRouteConfig } from "./router";

/** One model call's path: a provider row joined to a chain entry, with its key resolved. */
export type ResolvedRoute = {
  /** The entry's place in the saved chain; also what keeps two same-model entries apart. */
  readonly position: number;
  readonly providerId: string;
  readonly providerLabel: string;
  readonly modelId: string;
  readonly baseUrl: string;
  readonly apiKey: string;
};

/**
 * A route's name is its position in the chain plus what it is, because the router keys
 * its cooldowns and per-context affinity by name: two entries naming the same provider
 * and model must not share a suspension, and a rebuilt chain must not move one.
 */
export function routeNameOf(route: {
  readonly position: number;
  readonly providerId: string;
  readonly modelId: string;
}): string {
  return `${route.position}:${route.providerId}/${route.modelId}`;
}

/**
 * The router's routes, in chain order. An entry whose key could not be decrypted is left
 * out: a route that cannot authenticate would only add a failure round to every call.
 */
export function buildRouterRoutes(entries: readonly ResolvedRoute[]): (ProviderRouteConfig & {
  readonly provider: string;
  readonly model: string;
  readonly position: number;
})[] {
  return entries
    .filter((entry) => entry.apiKey.length > 0)
    .map((entry) => ({
      name: routeNameOf(entry),
      provider: entry.providerId,
      model: entry.modelId,
      position: entry.position,
      baseUrl: entry.baseUrl,
      apiKey: entry.apiKey,
    }));
}
