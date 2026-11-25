import { openAiStream, type AdapterEvent, type StreamFn, type StreamOptions } from "./openai";
import { ProviderError } from "./errors";

/** One route: an OpenAI-compatible endpoint plus the role it serves. */
export type ProviderRouteConfig = {
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly headers?: Readonly<Record<string, string>>;
};

/** First entry is preferred; every later entry is a fallback in order. */
export type ProvidersConfig = {
  readonly primary: ProviderRouteConfig;
  readonly fallbacks: readonly ProviderRouteConfig[];
};

export type RouterOptions = {
  /** How long a quota or authentication failure keeps a route out of rotation. */
  readonly cooldownMs?: number;
  /** Attempts on one route for transient failures before the next route is tried. */
  readonly retries?: number;
  readonly retryDelayMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Per-route transport override (tests and gateways with a shared fetch). */
  readonly fetchFor?: (route: ProviderRouteConfig) => typeof fetch | undefined;
  readonly onDiagnostic?: (diagnostic: ProviderDiagnostic) => void;
  /** Transport for every route, overriding the per-route hook (routing tests). */
  readonly fetchImplOverride?: typeof fetch;
};

/**
 * A routing decision worth showing the owner. `detail` carries upstream text
 * (including provider identifiers such as reset times), never a key.
 */
export type ProviderDiagnostic = {
  readonly kind:
    | "provider.retry"
    | "provider.fallback"
    | "provider.exhausted"
    | "provider.recovered";
  readonly provider: string;
  readonly model: string;
  readonly reason?: string;
  readonly retryInMs?: number;
  readonly failedProvider?: string;
  readonly contextKey?: string;
  readonly error?: string;
};

type Route = ProviderRouteConfig & { readonly index: number };

const DEFAULT_COOLDOWN_MS = 15 * 60_000;
const DEFAULT_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 250;

/**
 * Routes model calls with per-context affinity: a conversation keeps the route
 * it started on while that route is healthy, so one context is served by one
 * provider. Transient failures retry the same route and then fall back for this
 * call only. Quota and authentication failures suspend the route for a cooldown,
 * and the context moves to the next healthy route. A response that already
 * streamed text or tool calls is never replayed elsewhere.
 */
export function createRoutingStream(
  config: ProvidersConfig,
  options: RouterOptions = {},
): StreamFn & {
  readonly diagnostics: () => readonly ProviderDiagnostic[];
  readonly activeRoute: (contextKey: string) => string | null;
} {
  const routes: readonly Route[] = [config.primary, ...config.fallbacks].map((route, index) => ({
    ...route,
    index,
  }));
  const streams = new Map<number, StreamFn>();
  let fetchOverride: typeof fetch | undefined;
  /** A transport supplied after creation (a test override) rebuilds adapters lazily. */
  const transport = (route: Route): typeof fetch | undefined =>
    fetchOverride ?? options.fetchImplOverride ?? options.fetchFor?.(route);
  const stream = (route: Route): StreamFn => {
    const existing = streams.get(route.index);
    if (existing) return existing;
    const impl = transport(route);
    const created = openAiStream({
      baseUrl: route.baseUrl,
      apiKey: route.apiKey,
      model: route.model,
      ...(route.headers === undefined ? {} : { headers: route.headers }),
      ...(impl === undefined ? {} : { fetchImpl: impl }),
    });
    streams.set(route.index, created);
    return created;
  };

  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const cooldownUntil = new Map<number, number>();
  const preferred = new Map<string, number>();
  const history: ProviderDiagnostic[] = [];

  /** Per-call sink from StreamOptions, so a run's decisions reach its own log. */
  let callSink: ((diagnostic: ProviderDiagnostic) => void) | undefined;
  const report = (diagnostic: ProviderDiagnostic): void => {
    history.push(diagnostic);
    callSink?.(diagnostic);
    options.onDiagnostic?.(diagnostic);
  };

  /** Healthy routes in preference order: the context's route first, then config order. */
  const ranked = (contextKey: string): Route[] => {
    const at = now();
    const home = preferred.get(contextKey);
    const healthy = routes.filter((route) => (cooldownUntil.get(route.index) ?? 0) <= at);
    return healthy.toSorted((a, b) => {
      const rank = (route: Route) => (route.index === home ? 0 : route.index + 1);
      return rank(a) - rank(b);
    });
  };

  const describe = (error: ProviderError): string =>
    error.detail && error.detail.length > 0 ? error.message : error.kind;

  async function* run(
    request: readonly Message[],
    tools: readonly ToolSpec[],
    streamOptions: Omit<StreamOptions, "fetchImpl">,
  ): AsyncIterable<AdapterEvent> {
    const contextKey = streamOptions.contextKey ?? "default";
    const candidates = ranked(contextKey);
    if (candidates.length === 0) {
      const next = Math.min(...routes.map((route) => cooldownUntil.get(route.index) ?? 0));
      const waitMs = Math.max(0, next - now());
      report({
        kind: "provider.exhausted",
        provider: routes[0]?.name ?? "unknown",
        model: routes[0]?.model ?? "unknown",
        reason: "all routes are in cooldown",
        retryInMs: waitMs,
        contextKey,
      });
      throw new ProviderError(
        "quota_exhausted",
        503,
        `모든 모델 경로가 사용할 수 없습니다. 가장 빠른 경로는 ${Math.ceil(waitMs / 60_000)}분 후 다시 열립니다.`,
      );
    }

    const failures: string[] = [];
    for (const [position, route] of candidates.entries()) {
      let attempt = 0;
      while (true) {
        if (streamOptions.signal?.aborted) throw new ProviderError("aborted");
        attempt += 1;
        const emitted: AdapterEvent[] = [];
        try {
          for await (const event of stream(route)(request, tools, {
            ...streamOptions,
            contextKey,
          })) {
            if (event.type !== "done") emitted.push(event);
            yield event;
          }
          preferred.set(contextKey, route.index);
          return;
        } catch (error) {
          const providerError =
            error instanceof ProviderError
              ? error
              : new ProviderError("transport", undefined, errorMessage(error));
          const visible = emitted.some(
            (event) => event.type === "text_delta" || event.type === "tool_call",
          );
          if (providerError.kind === "aborted" || streamOptions.signal?.aborted) {
            throw providerError;
          }
          if (visible) throw providerError;
          failures.push(`${route.name}/${route.model}: ${describe(providerError)}`);
          if (providerError.unhealthy) {
            cooldownUntil.set(route.index, now() + cooldownMs);
            preferred.delete(contextKey);
            report({
              kind: "provider.fallback",
              provider: candidates[position + 1]?.name ?? route.name,
              model: candidates[position + 1]?.model ?? route.model,
              reason: providerError.kind,
              retryInMs: cooldownMs,
              failedProvider: route.name,
              contextKey,
              error: describe(providerError),
            });
            break;
          }
          if (providerError.transient && attempt <= retries) {
            report({
              kind: "provider.retry",
              provider: route.name,
              model: route.model,
              reason: providerError.kind,
              contextKey,
              error: describe(providerError),
            });
            await sleep(retryDelayMs * attempt);
            continue;
          }
          report({
            kind: "provider.fallback",
            provider: candidates[position + 1]?.name ?? route.name,
            model: candidates[position + 1]?.model ?? route.model,
            reason: providerError.kind,
            retryInMs: 0,
            failedProvider: route.name,
            contextKey,
            error: describe(providerError),
          });
          break;
        }
      }
    }

    report({
      kind: "provider.exhausted",
      provider: routes[0]?.name ?? "unknown",
      model: routes[0]?.model ?? "unknown",
      reason: "every route failed",
      retryInMs: 0,
      contextKey,
    });
    throw new ProviderError(
      "quota_exhausted",
      undefined,
      `모든 모델 경로가 실패했습니다.\n${failures.join("\n")}`,
    );
  }
  const routed = async function* (
    messages: readonly Message[],
    tools: readonly ToolSpec[],
    streamOptions: StreamOptions,
  ): AsyncIterable<AdapterEvent> {
    // A caller-supplied transport applies to whichever route is reached.
    if (streamOptions.fetchImpl && options.fetchFor === undefined) {
      if (fetchOverride !== streamOptions.fetchImpl) streams.clear();
      fetchOverride = streamOptions.fetchImpl;
    }
    callSink = streamOptions.onDiagnostic;
    try {
      yield* run(messages, tools, streamOptions);
    } finally {
      callSink = undefined;
    }
  } as StreamFn;

  return Object.assign(routed, {
    diagnostics: () => history,
    activeRoute: (contextKey: string) => {
      const home = preferred.get(contextKey);
      return home === undefined
        ? null
        : (routes.find((route) => route.index === home)?.name ?? null);
    },
  });
}

type Message = Parameters<StreamFn>[0][number];
type ToolSpec = Parameters<StreamFn>[1][number];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
