import { z } from "zod";

/**
 * Which upstream features a provider is known to answer. A predefined provider says
 * so from its published API; a custom OpenAI-compatible server is assumed to answer
 * the plain catalog only, and the screen says so instead of pretending otherwise.
 */
export type CatalogCapability = "models" | "usage";

/** One model the provider serves, as the picker shows it. */
export type ModelOffer = {
  readonly id: string;
  readonly label: string;
  /** The kind of chat usage only chat models are offered for routing. */
  readonly kind: "chat" | "other";
  readonly contextLength: number | null;
  readonly maxOutput: number | null;
  readonly inputPrice: number | null;
  readonly outputPrice: number | null;
  readonly tags: readonly string[];
};

/** One usage meter or limit the provider reports, ready to show. */
export type UsageMeter = {
  readonly id: string;
  readonly label: string;
  /** Share used, 0..100; null for a limit that is not a percentage. */
  readonly percent: number | null;
  readonly status: string;
  /** ISO instant the meter resets, when the provider says. */
  readonly resetsAt: string | null;
  /** Value shown as-is when the meter is not a percentage (e.g. a concurrent limit). */
  readonly text: string | null;
};

export type ProviderUsage = {
  /** Meters, percent windows first, then plain numbers. */
  readonly meters: readonly UsageMeter[];
  /** ISO instant of the earliest spent window, when one is known. */
  readonly nextResetAt: string | null;
};

/** What the screen is told about one probe: the offers, the usage, and each failure verbatim. */
export type ProbeResult = {
  readonly models: readonly ModelOffer[];
  readonly usage: ProviderUsage | null;
  readonly modelsError: string | null;
  readonly usageError: string | null;
  readonly fetchedAt: string;
};

export type ProbeContext = {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
};

export type ProviderCatalog = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly baseUrl: string | null;
  readonly docsUrl: string;
  readonly capabilities: readonly CatalogCapability[];
  readonly modelsPath: string;
  readonly usagePath: string | null;
  /** Reads the provider's own catalog into offers. */
  readonly models: (ctx: ProbeContext) => Promise<ModelOffer[]>;
  /** Reads the provider's usage/limits; null when it has none to report. */
  readonly usage: ((ctx: ProbeContext) => Promise<ProviderUsage>) | null;
};

const OFFER_LIMIT = 500;
const TIMEOUT_MS = 15_000;

/** One upstream read: the status and the decoded body, so a failure keeps its own words. */
export async function readUpstream(
  url: string,
  ctx: ProbeContext,
  init: { readonly method?: string; readonly body?: unknown } = {},
): Promise<{ ok: boolean; status: number; body: unknown; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs ?? TIMEOUT_MS);
  try {
    const response = await (ctx.fetchImpl ?? globalThis.fetch)(url, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${ctx.apiKey}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...ctx.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: controller.signal,
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // A non-JSON answer stays text so the error can be repeated verbatim.
    }
    return { ok: response.ok, status: response.status, body, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The provider's own words for a failed read. An OpenAI-shaped envelope carries its
 * message under `error`; anything else is repeated as received, cut to something a
 * screen can show.
 */
export function upstreamError(status: number, body: unknown, text: string): string {
  const envelope = z
    .object({ error: z.union([z.string(), z.object({ message: z.string().optional() })]) })
    .safeParse(body);
  const detail = envelope.success
    ? typeof envelope.data.error === "string"
      ? envelope.data.error
      : (envelope.data.error.message ?? text)
    : typeof body === "string"
      ? body
      : JSON.stringify(body);
  const clipped = detail.trim().slice(0, 600);
  return `HTTP ${status}${clipped.length > 0 ? ` · ${clipped}` : ""}`;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function join(url: string, path: string): string {
  return `${url.replace(/\/+$/, "")}${path.startsWith("/") ? "" : "/"}${path}`;
}

const GoModelSchema = z.object({
  id: z.string(),
  name: z.string().nullish(),
  type: z.string().nullish(),
  limit: z.object({ context: z.number().nullish(), output: z.number().nullish() }).nullish(),
  cost: z
    .object({
      text: z
        .object({
          input: z.object({ price: z.number().nullish() }).nullish(),
          output: z.object({ price: z.number().nullish() }).nullish(),
        })
        .nullish(),
    })
    .nullish(),
  capabilities: z.object({ tools: z.object({ supported: z.boolean() }).nullish() }).nullish(),
});

/** OpenCode Go's catalog, in OpenAI's list shape with models.dev fields per item. */
export function goOffersOf(body: unknown): ModelOffer[] {
  const parsed = z.object({ data: z.array(z.unknown()) }).safeParse(body);
  if (!parsed.success) throw new Error("OpenCode Go 모델 목록 형식이 아닙니다.");
  const offers: ModelOffer[] = [];
  for (const raw of parsed.data.data.slice(0, OFFER_LIMIT)) {
    const model = GoModelSchema.safeParse(raw);
    if (!model.success) continue;
    const kind = (model.data.type ?? "chat") === "chat" ? "chat" : "other";
    const tools = model.data.capabilities?.tools?.supported === true;
    offers.push({
      id: model.data.id,
      label: model.data.name ?? model.data.id,
      kind,
      contextLength: numberOrNull(model.data.limit?.context),
      maxOutput: numberOrNull(model.data.limit?.output),
      inputPrice: numberOrNull(model.data.cost?.text?.input?.price),
      outputPrice: numberOrNull(model.data.cost?.text?.output?.price),
      tags: [model.data.type ?? "chat", ...(kind === "chat" && !tools ? ["no-tools"] : [])],
    });
  }
  return offers;
}

const DeepInfraModelSchema = z.object({
  id: z.string(),
  metadata: z
    .object({
      description: z.string().nullish(),
      context_length: z.number().nullish(),
      max_tokens: z.number().nullish(),
      pricing: z.record(z.string(), z.unknown()).nullish(),
      tags: z.array(z.string()).nullish(),
    })
    .nullish(),
});

/** DeepInfra's `/v1/openai/models`: OpenAI list shape with per-model metadata. */
export function deepInfraOffersOf(body: unknown): ModelOffer[] {
  const parsed = z.object({ data: z.array(z.unknown()) }).safeParse(body);
  if (!parsed.success) throw new Error("DeepInfra 모델 목록 형식이 아닙니다.");
  const offers: ModelOffer[] = [];
  for (const raw of parsed.data.data.slice(0, OFFER_LIMIT)) {
    const model = DeepInfraModelSchema.safeParse(raw);
    if (!model.success) continue;
    const tags = model.data.metadata?.tags ?? [];
    const kind = tags.includes("chat") || tags.includes("vlm") ? "chat" : "other";
    offers.push({
      id: model.data.id,
      label: model.data.id,
      kind,
      contextLength: numberOrNull(model.data.metadata?.context_length),
      maxOutput: numberOrNull(model.data.metadata?.max_tokens),
      inputPrice: numberOrNull(model.data.metadata?.pricing?.["input_tokens"]),
      outputPrice: numberOrNull(model.data.metadata?.pricing?.["output_tokens"]),
      tags,
    });
  }
  return offers;
}

/** A plain OpenAI-compatible `/models` answer: ids only unless the server adds fields. */
export function genericOffersOf(body: unknown): ModelOffer[] {
  const parsed = z.object({ data: z.array(z.unknown()) }).safeParse(body);
  if (!parsed.success) throw new Error("OpenAI 호환 모델 목록 형식이 아닙니다.");
  const offers: ModelOffer[] = [];
  for (const raw of parsed.data.data.slice(0, OFFER_LIMIT)) {
    const item = z.object({ id: z.string(), name: z.string().nullish() }).safeParse(raw);
    if (!item.success) continue;
    offers.push({
      id: item.data.id,
      label: item.data.name ?? item.data.id,
      kind: "chat",
      contextLength: null,
      maxOutput: null,
      inputPrice: null,
      outputPrice: null,
      tags: [],
    });
  }
  return offers;
}

const UsageWindowSchema = z.object({
  status: z.string(),
  percent: z.number(),
  resetsAt: z.string(),
});

/** OpenCode Go's usage windows: rolling (5h), weekly, monthly. */
export function goUsageOf(body: unknown): ProviderUsage {
  const parsed = z.object({ usage: z.record(z.string(), UsageWindowSchema) }).safeParse(body);
  if (!parsed.success) throw new Error("OpenCode Go 사용량 형식이 아닙니다.");
  const labels: Record<string, string> = {
    rolling: "5시간",
    weekly: "주간",
    monthly: "월간",
  };
  const meters: UsageMeter[] = [];
  let nextResetAt: string | null = null;
  for (const [id, window] of Object.entries(parsed.data.usage)) {
    const spent = window.status !== "ok" || window.percent >= 100;
    const reset = Date.parse(window.resetsAt);
    if (
      spent &&
      Number.isFinite(reset) &&
      (nextResetAt === null || reset < Date.parse(nextResetAt))
    )
      nextResetAt = window.resetsAt;
    meters.push({
      id,
      label: labels[id] ?? id,
      percent: window.percent,
      status: window.status,
      resetsAt: Number.isFinite(reset) ? window.resetsAt : null,
      text: null,
    });
  }
  return { meters, nextResetAt };
}

/** DeepInfra's account rate limits: concurrent requests and tokens per minute per model. */
export function deepInfraUsageOf(
  rateLimit: unknown,
  spending: unknown,
  now: number,
): ProviderUsage {
  const parsed = z
    .object({ rate_limit: z.number(), tpm_rate_limit: z.number() })
    .safeParse(rateLimit);
  if (!parsed.success) throw new Error("DeepInfra 사용량 형식이 아닙니다.");
  const meters: UsageMeter[] = [
    {
      id: "concurrency",
      label: "모델당 동시 요청",
      percent: null,
      status: "limit",
      resetsAt: null,
      text: String(parsed.data.rate_limit),
    },
    {
      id: "tpm",
      label: "모델당 분당 토큰",
      percent: null,
      status: "limit",
      resetsAt: null,
      text: parsed.data.tpm_rate_limit.toLocaleString("ko-KR"),
    },
  ];
  // The month's spend is a number to show, not a limit the API answers as a percent.
  const month = z
    .object({
      months: z.array(z.object({ period: z.string(), total_cost: z.number() })).min(1),
    })
    .safeParse(spending);
  const current = month.success ? (month.data.months.at(-1) ?? null) : null;
  if (current)
    meters.push({
      id: "month_cost",
      label: `${current.period} 사용액 (USD)`,
      percent: null,
      status: "spend",
      resetsAt: null,
      text: (current.total_cost / 100).toFixed(2),
    });
  void now;
  return { meters, nextResetAt: null };
}

function monthPeriod(now: number): string {
  const date = new Date(now);
  return `${date.getUTCFullYear()}.${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function modelsAt(
  path: string,
  parse: (body: unknown) => ModelOffer[],
  ctx: ProbeContext,
): Promise<ModelOffer[]> {
  const read = await readUpstream(join(ctx.baseUrl, path), ctx);
  if (!read.ok) throw new Error(upstreamError(read.status, read.body, read.text));
  return parse(read.body);
}

const OPENCODE_GO: ProviderCatalog = {
  id: "opencode-go",
  label: "OpenCode Go",
  description: "OpenCode Go 구독 키. 모델 목록과 5시간/주간/월간 사용량 한도를 함께 제공합니다.",
  baseUrl: "https://opencode.ai/inference/go/v1",
  docsUrl: "https://opencode.ai/docs/console/go/",
  capabilities: ["models", "usage"],
  modelsPath: "/models",
  usagePath: "/usage",
  models: (ctx) => modelsAt("/models", goOffersOf, ctx),
  usage: async (ctx) => {
    const read = await readUpstream(join(ctx.baseUrl, "/usage"), ctx);
    if (!read.ok) throw new Error(upstreamError(read.status, read.body, read.text));
    return goUsageOf(read.body);
  },
};

const DEEPINFRA: ProviderCatalog = {
  id: "deepinfra",
  label: "DeepInfra",
  description: "DeepInfra 키. OpenAI 호환 채팅에 모델별 한도와 이번 달 사용액을 함께 보여줍니다.",
  baseUrl: "https://api.deepinfra.com/v1/openai",
  docsUrl: "https://docs.deepinfra.com/api-reference/introduction",
  capabilities: ["models", "usage"],
  modelsPath: "/models",
  usagePath: "/v1/me/rate_limit",
  models: (ctx) => modelsAt("/models", deepInfraOffersOf, ctx),
  usage: async (ctx) => {
    // Limits and spend live on the account API, above the OpenAI-compatible base.
    const root = ctx.baseUrl.replace(/\/v1\/openai\/?$/, "");
    const origin = /^https?:\/\/[^/]+/.exec(root)?.[0] ?? root;
    const limits = await readUpstream(join(origin, "/v1/me/rate_limit"), ctx);
    if (!limits.ok)
      throw new Error(`한도 조회 · ${upstreamError(limits.status, limits.body, limits.text)}`);
    const spending = await readUpstream(
      `${join(origin, "/payment/usage")}?from=${monthPeriod(Date.now())}`,
      ctx,
    );
    return deepInfraUsageOf(limits.body, spending.ok ? spending.body : null, Date.now());
  },
};

/**
 * Any OpenAI-compatible server. Only the plain catalog is assumed; a server that
 * answers it lists its models, and its usage is unknown rather than invented.
 */
const CUSTOM: ProviderCatalog = {
  id: "custom",
  label: "OpenAI 호환 서버",
  description: "직접 입력한 base URL과 키. /models가 OpenAI 형식이면 모델 목록을 가져옵니다.",
  baseUrl: null,
  docsUrl: "https://platform.openai.com/docs/api-reference/models/list",
  capabilities: ["models"],
  modelsPath: "/models",
  usagePath: null,
  models: (ctx) => modelsAt("/models", genericOffersOf, ctx),
  usage: null,
};

export const PROVIDER_CATALOGS: readonly ProviderCatalog[] = [OPENCODE_GO, DEEPINFRA, CUSTOM];

export function catalogOf(id: string): ProviderCatalog | null {
  return PROVIDER_CATALOGS.find((catalog) => catalog.id === id) ?? null;
}

/**
 * Every catalog's read in one outcome: one side failing never hides the other, and
 * both failures keep the provider's own words for the screen.
 */
export async function probeProvider(
  catalog: ProviderCatalog,
  ctx: ProbeContext,
): Promise<ProbeResult> {
  const [models, usage] = await Promise.all([
    catalog
      .models(ctx)
      .then((offers) => ({ offers, error: null as string | null }))
      .catch((error: unknown) => ({
        offers: [] as ModelOffer[],
        error: error instanceof Error ? error.message : String(error),
      })),
    catalog.usage === null
      ? Promise.resolve({ usage: null as ProviderUsage | null, error: null as string | null })
      : catalog
          .usage(ctx)
          .then((result) => ({ usage: result, error: null as string | null }))
          .catch((error: unknown) => ({
            usage: null as ProviderUsage | null,
            error: error instanceof Error ? error.message : String(error),
          })),
  ]);
  return {
    models: models.offers,
    usage: usage.usage,
    modelsError: models.error,
    usageError: usage.error,
    fetchedAt: new Date().toISOString(),
  };
}
