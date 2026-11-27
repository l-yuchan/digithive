import { z } from "zod";

/**
 * What the provider settings screen reads. The shapes mirror `src/providers/store.ts` and
 * `src/providers/catalog.ts`: a provider carries a key hint and never a key, and each of
 * its two upstream reads keeps its own error so one failure cannot hide the other.
 */
export const ModelOfferSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["chat", "other"]),
  contextLength: z.number().nullable(),
  maxOutput: z.number().nullable(),
  inputPrice: z.number().nullable(),
  outputPrice: z.number().nullable(),
  tags: z.array(z.string()),
});
export type ModelOffer = z.infer<typeof ModelOfferSchema>;

export const UsageMeterSchema = z.object({
  id: z.string(),
  label: z.string(),
  percent: z.number().nullable(),
  status: z.string(),
  resetsAt: z.string().nullable(),
  text: z.string().nullable(),
});
export const ProviderUsageSchema = z.object({
  meters: z.array(UsageMeterSchema),
  nextResetAt: z.string().nullable(),
});
export type ProviderUsage = z.infer<typeof ProviderUsageSchema>;

export const CatalogSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  baseUrl: z.string().nullable(),
  docsUrl: z.string(),
  capabilities: z.array(z.string()),
});
export type Catalog = z.infer<typeof CatalogSchema>;

export const ProviderSchema = z.object({
  id: z.string(),
  catalogId: z.string(),
  label: z.string(),
  baseUrl: z.string(),
  enabled: z.boolean(),
  keyHint: z.string().nullable(),
  headers: z.record(z.string(), z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
  modelsFetchedAt: z.string().nullable(),
  modelsError: z.string().nullable(),
  usage: ProviderUsageSchema.nullable(),
  usageFetchedAt: z.string().nullable(),
  usageError: z.string().nullable(),
  models: z.array(ModelOfferSchema),
  catalog: z.object({
    label: z.string(),
    capabilities: z.array(z.string()),
    docsUrl: z.string(),
    known: z.boolean(),
  }),
});
export type Provider = z.infer<typeof ProviderSchema>;

export const ChainEntrySchema = z.object({
  position: z.number(),
  providerId: z.string(),
  providerLabel: z.string(),
  catalogId: z.string(),
  baseUrl: z.string(),
  modelId: z.string(),
  modelLabel: z.string(),
  enabled: z.boolean(),
  providerEnabled: z.boolean(),
});
export type ChainEntry = z.infer<typeof ChainEntrySchema>;

export const RouteSchema = z.object({
  name: z.string(),
  providerId: z.string(),
  providerLabel: z.string(),
  modelId: z.string(),
  baseUrl: z.string(),
});
export type Route = z.infer<typeof RouteSchema>;

/** The whole settings read: catalogs to add from, providers, the chain, and what runs. */
export const ProvidersOverviewSchema = z.object({
  catalogs: z.array(CatalogSchema),
  providers: z.array(ProviderSchema),
  chain: z.array(ChainEntrySchema),
  routes: z.array(RouteSchema),
});
export type ProvidersOverview = z.infer<typeof ProvidersOverviewSchema>;

export const ChainResponseSchema = z.object({
  chain: z.array(ChainEntrySchema),
  routes: z.array(RouteSchema),
});

export const ProbeResultSchema = z.object({
  models: z.array(ModelOfferSchema),
  usage: ProviderUsageSchema.nullable(),
  modelsError: z.string().nullable(),
  usageError: z.string().nullable(),
  fetchedAt: z.string(),
  stored: z.boolean().optional(),
});

export const ModelTestSchema = z.object({
  ok: z.boolean(),
  status: z.number().optional(),
  latencyMs: z.number().optional(),
  answer: z.string().nullable().optional(),
  error: z.string().optional(),
  body: z.string().optional(),
});

/** A model's size in something a person reads: 262144 → "256K". */
export function formatTokens(value: number | null): string {
  if (value === null) return "?";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

/** US dollars per 1M tokens, as the provider stated them. */
export function formatPrice(value: number | null): string {
  if (value === null) return "?";
  return `$${value.toFixed(value < 1 ? 3 : 2)}`;
}

/** What a chat model's limits say in one line: context, output, price per 1M tokens. */
export function offerSummary(offer: ModelOffer): string {
  const parts = [`컨텍스트 ${formatTokens(offer.contextLength)}`];
  if (offer.maxOutput !== null) parts.push(`출력 ${formatTokens(offer.maxOutput)}`);
  if (offer.inputPrice !== null || offer.outputPrice !== null)
    parts.push(
      `입력 ${formatPrice(offer.inputPrice)} · 출력 ${formatPrice(offer.outputPrice)} /1M`,
    );
  return parts.join(" · ");
}

/** A reset instant in the owner's zone, or the raw text when it cannot be read. */
export function formatReset(iso: string | null): string {
  if (iso === null) return "";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return iso;
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(at));
}
