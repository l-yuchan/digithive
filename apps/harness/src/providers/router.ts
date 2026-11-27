import { openAiStream, type AdapterEvent, type StreamFn, type StreamOptions } from "./openai";
import { ProviderError } from "./errors";
import { OPENCODE_SESSION_HEADER } from "./usage";

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

/** When a route suspended by quota may be used again, and which window said so. */
export type UsageResume = {
  readonly resumeAt: number;
  readonly window: string;
};

export type RouterOptions = {
  /**
   * How long a quota or authentication failure keeps a route out of rotation when
   * nothing says when access returns. A reported reset — in the failure's own text
   * or in the provider's usage windows — replaces it.
   */
  readonly cooldownMs?: number;
  /** Reads a provider's usage windows to learn when a quota returns. */
  readonly usageProbe?: (
    route: ProviderRouteConfig,
    signal?: AbortSignal,
  ) => Promise<UsageResume | null>;
  /** Attempts on one route for transient failures before the next route is tried. */
  readonly retries?: number;
  readonly retryDelayMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Per-route transport override (tests, gateways with a shared fetch). */
  readonly fetchFor?: (route: ProviderRouteConfig) => typeof fetch | undefined;
  readonly onDiagnostic?: (diagnostic: ProviderDiagnostic) => void;
  /** Transport for every route, overriding the per-route hook (routing tests). */
  readonly fetchImplOverride?: typeof fetch;
  /**
   * The routes themselves, read on every model call. When given, this is the whole route
   * list and `config` is only its starting point: a provider added, switched off or
   * deleted on the settings screen applies to the next call in this process and in the
   * worker without a restart. What is sent for each new route is derived from its own
   * name, so a route keeps its transport, its cooldown and its affinity by identity.
   */
  readonly routes?: () => readonly ProviderRouteConfig[];
  /**
   * Saved route order by route name (the owner's settings). Read on every model
   * call, so a change applies to the next call. A listed name comes in that order;
   * a route the list does not name keeps config order after the listed ones, and a
   * name no route carries is ignored. When the order changes, a context's saved
   * affinity is dropped so the order the owner just saved decides the next call.
   */
  readonly priority?: () => readonly string[];
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
  /** ISO instant the suspended route may be used again; absent when none is known. */
  readonly until?: string;
  readonly failedProvider?: string;
  readonly contextKey?: string;
  readonly error?: string;
};

type Route = ProviderRouteConfig & { readonly index: number };

/**
 * OpenCode's gateway asks every client to name the session with
 * `x-opencode-session`; without it a request is refused outright (HTTP 400
 * MissingSessionID). The header is a property of that route, so it is added here
 * rather than by whichever process happens to call it.
 */
function withGatewayHeaders(route: ProviderRouteConfig): ProviderRouteConfig {
  if (!route.baseUrl.includes("opencode.ai")) return route;
  return {
    ...route,
    headers: { ...route.headers, [OPENCODE_SESSION_HEADER]: route.name },
  };
}

const DEFAULT_COOLDOWN_MS = 15 * 60_000;
const DEFAULT_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 250;

/**
 * Reads the reset a failure's own text names: "resets in 1d 11h", "resets in 31m".
 * Milliseconds from now, or null when the text names none.
 */
export function namedResetMs(detail: string): number | null {
  const match = /resets? in ((?:\d+[dhms]\s*)+)/i.exec(detail);
  if (!match?.[1]) return null;
  const units: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 };
  let total = 0;
  for (const part of match[1].matchAll(/(\d+)([dhms])/gi)) {
    total += Number(part[1] ?? 0) * (units[(part[2] ?? "s").toLowerCase()] ?? 0);
  }
  return total > 0 ? total : null;
}

/** A wait the owner can read: minutes for brief holds, larger units after. */
export function formatWait(ms: number): string {
  const minutes = Math.max(0, Math.ceil(ms / 60_000));
  if (minutes < 180) return `${minutes}분`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return rest === 0 ? `${hours}시간` : `${hours}시간 ${rest}분`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}일` : `${days}일 ${restHours}시간`;
}

/**
 * Routes model calls with per-context affinity: a conversation keeps the route
 * it started on while that route is healthy, so one context is served by one
 * provider. Transient failures retry the same route and then fall back for this
 * call only. Quota and authentication failures suspend the route — until the reset
 * the provider reports, or a fixed cooldown when it reports none — and the context
 * moves to the next healthy route. The owner's saved route order decides which
 * route is next. A response that already streamed text or tool calls is never
 * replayed elsewhere.
 */
export function createRoutingStream(
  config: ProvidersConfig,
  options: RouterOptions = {},
): StreamFn & {
  readonly diagnostics: () => readonly ProviderDiagnostic[];
  readonly activeRoute: (contextKey: string) => string | null;
} {
  const headerized = (route: ProviderRouteConfig, index: number): Route => ({
    ...withGatewayHeaders(route),
    index,
  });
  const configRoutes: readonly Route[] = [config.primary, ...config.fallbacks].map(headerized);
  /** The routes this call may use: the saved chain when it is live, else the config. */
  const currentRoutes = (): readonly Route[] =>
    options.routes === undefined
      ? configRoutes
      : options.routes().map((route, index) => headerized(route, index));
  const streams = new Map<string, StreamFn>();
  let fetchOverride: typeof fetch | undefined;
  /**
   * Every route reads its own endpoint through this network fetch when no
   * per-route transport is configured. `fetch` looked up unbound and called
   * without its global object is not a callable transport.
   */
  const network = globalThis.fetch.bind(globalThis);
  const transport = (route: Route): typeof fetch =>
    fetchOverride ?? options.fetchImplOverride ?? options.fetchFor?.(route) ?? network;
  const stream = (route: Route): StreamFn => {
    const existing = streams.get(route.name);
    if (existing) return existing;
    const created = openAiStream({
      baseUrl: route.baseUrl,
      apiKey: route.apiKey,
      model: route.model,
      ...(route.headers === undefined ? {} : { headers: route.headers }),
    });
    streams.set(route.name, created);
    return created;
  };

  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  // Cooldowns and failures belong to the route's identity (its name), never to its
  // position: reordering routes in settings must not move a suspension onto a
  // healthy route or lose one from the route that earned it.
  const cooldownUntil = new Map<string, number>();
  const preferred = new Map<string, string>();
  /** The last failure per route, kept so an exhausted answer says why. */
  const lastError = new Map<string, ProviderError>();
  const history: ProviderDiagnostic[] = [];
  let lastPrioritySignature: string | null = null;

  /** Per-call sink from StreamOptions, so a run's decisions reach its own log. */
  let callSink: ((diagnostic: ProviderDiagnostic) => void) | undefined;
  const report = (diagnostic: ProviderDiagnostic): void => {
    history.push(diagnostic);
    callSink?.(diagnostic);
    options.onDiagnostic?.(diagnostic);
  };

  /**
   * How long a route's failure keeps it out of rotation. A reset the provider
   * reported is exact, so the route returns the moment its quota does; the fixed
   * cooldown only covers a provider that says nothing.
   */
  const suspendFor = async (route: Route, error: ProviderError): Promise<number> => {
    if (error.kind !== "quota_exhausted") return cooldownMs;
    const named = namedResetMs(error.detail ?? "");
    if (named !== null) return named;
    if (!options.usageProbe) return cooldownMs;
    const resume = await options.usageProbe(route).catch(() => null);
    return resume === null ? cooldownMs : Math.max(0, resume.resumeAt - now());
  };

  /**
   * Healthy routes in preference order: the saved order (when settings name one),
   * config order for the rest, and the context's route first while the saved order
   * stands. A changed saved order starts a fresh ranking, so an affinity formed
   * under the old order cannot keep a route the owner moved down the list.
   */
  const ranked = (contextKey: string): Route[] => {
    const at = now();
    const priority = options.priority?.() ?? [];
    const signature = priority.join("\u0000");
    if (lastPrioritySignature !== null && signature !== lastPrioritySignature) {
      preferred.clear();
    }
    lastPrioritySignature = signature;
    // The first mention of a name wins, so a duplicated entry cannot reorder twice.
    const saved = new Map<string, number>();
    for (const [position, name] of priority.entries()) {
      if (!saved.has(name)) saved.set(name, position);
    }
    const ordered = currentRoutes().toSorted((left, right) => {
      const leftRank = saved.get(left.name) ?? priority.length + left.index;
      const rightRank = saved.get(right.name) ?? priority.length + right.index;
      return leftRank - rightRank;
    });
    const home = preferred.get(contextKey);
    const healthy = ordered.filter((route) => (cooldownUntil.get(route.name) ?? 0) <= at);
    return healthy.toSorted(
      (left, right) => Number(left.name !== home) - Number(right.name !== home),
    );
  };

  /** The route a caller should be told about next: the first one out of cooldown. */
  const soonest = (): { route: Route; waitMs: number } | null => {
    const live = currentRoutes();
    const open = live
      .map((route) => ({ route, until: cooldownUntil.get(route.name) ?? 0 }))
      .filter((entry) => entry.until > now())
      .toSorted((left, right) => left.until - right.until);
    const next = open[0];
    return next ? { route: next.route, waitMs: Math.max(0, next.until - now()) } : null;
  };

  /**
   * The one error for an answer that cannot be produced: every route is suspended,
   * or every route failed on this call. It names the route that returns first and
   * when, and repeats what each route actually said.
   */
  const outage = (contextKey: string, where: "cooldown" | "failed"): ProviderError => {
    const next = soonest();
    const live = currentRoutes();
    const reasons = [...lastError.values()].map((error) => error.message);
    report({
      kind: "provider.exhausted",
      provider: next?.route.name ?? live.at(0)?.name ?? "unknown",
      model: next?.route.model ?? live.at(0)?.model ?? "unknown",
      reason: where === "cooldown" ? "all routes are in cooldown" : "every route failed",
      retryInMs: next?.waitMs ?? 0,
      ...(next ? { until: new Date(now() + next.waitMs).toISOString() } : {}),
      contextKey,
      ...(reasons.length > 0 ? { error: reasons.join("\n") } : {}),
    });
    const headline = next
      ? `모든 모델 경로를 지금은 쓸 수 없습니다. ${next.route.name} 경로가 ${formatWait(next.waitMs)} 후 다시 열립니다.`
      : "모든 모델 경로가 실패했습니다.";
    return new ProviderError(
      "quota_exhausted",
      503,
      [headline, ...reasons].filter((line) => line.length > 0).join("\n"),
    );
  };

  const describe = (error: ProviderError): string =>
    error.detail && error.detail.length > 0 ? error.message : error.kind;

  async function* run(
    request: readonly Message[],
    tools: readonly ToolSpec[],
    streamOptions: Omit<StreamOptions, "fetchImpl">,
  ): AsyncIterable<AdapterEvent> {
    const contextKey = streamOptions.contextKey ?? "default";
    // Every model call is routed again, including the next round of one reply: a
    // route suspended a moment ago is still suspended now, and the round must not
    // replay it because the previous round happened to answer.
    if (ranked(contextKey).length === 0) throw outage(contextKey, "cooldown");

    // Fixed before any suspension, so "the next route" stays the route after this one.
    const candidates = ranked(contextKey);
    for (const [position, route] of candidates.entries()) {
      const next = candidates[position + 1];
      let attempt = 0;
      while (true) {
        if (streamOptions.signal?.aborted) throw new ProviderError("aborted");
        attempt += 1;
        const emitted: AdapterEvent[] = [];
        try {
          for await (const event of stream(route)(request, tools, {
            ...streamOptions,
            contextKey,
            // Each route reads through its own transport: the endpoint belongs to the
            // route, never to whichever transport answered the previous call.
            fetchImpl: transport(route),
          })) {
            if (event.type !== "done") emitted.push(event);
            yield event;
          }
          preferred.set(contextKey, route.name);
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
          lastError.set(route.name, providerError);
          if (providerError.unhealthy) {
            const held = await suspendFor(route, providerError);
            cooldownUntil.set(route.name, now() + held);
            preferred.delete(contextKey);
            // A "switch" needs a route to switch to. With none left, the exhaustion
            // below is the one honest answer; naming this route as its own fallback
            // is what made a single-route setup read as "primary → primary".
            if (next !== undefined) {
              report({
                kind: "provider.fallback",
                provider: next.name,
                model: next.model,
                reason: providerError.kind,
                retryInMs: held,
                until: new Date(now() + held).toISOString(),
                failedProvider: route.name,
                contextKey,
                error: describe(providerError),
              });
            }
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
          if (next !== undefined) {
            report({
              kind: "provider.fallback",
              provider: next.name,
              model: next.model,
              reason: providerError.kind,
              retryInMs: 0,
              failedProvider: route.name,
              contextKey,
              error: describe(providerError),
            });
          }
          break;
        }
      }
    }
    throw outage(contextKey, "failed");
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
    activeRoute: (contextKey: string) => preferred.get(contextKey) ?? null,
  });
}

type Message = Parameters<StreamFn>[0][number];
type ToolSpec = Parameters<StreamFn>[1][number];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
