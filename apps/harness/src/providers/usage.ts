import { z } from "zod";
import type { UsageResume } from "./router";

/** A provider's usage windows, as OpenCode Go publishes them. */
const WindowSchema = z.object({
  status: z.string(),
  percent: z.number(),
  resetsAt: z.string(),
});
const UsageSchema = z.object({
  usage: z.object({
    rolling: WindowSchema,
    weekly: WindowSchema,
    monthly: WindowSchema,
  }),
});

/**
 * When a route's quota returns, according to the provider's own usage windows.
 *
 * The earliest reset among the spent windows is the moment access comes back; the
 * other windows are not spent and say nothing about it. Reading the answer is not
 * the point — the reset instant is what a cooldown should be — so an entry whose
 * reset is not an instant is ignored rather than guessed at.
 */
export function usageResumeOf(body: unknown, now: number): UsageResume | null {
  const parsed = UsageSchema.safeParse(body);
  if (!parsed.success) return null;
  let best: { resumeAt: number; window: string } | null = null;
  for (const [window, meter] of Object.entries(parsed.data.usage)) {
    const spent = meter.status !== "ok" || meter.percent >= 100;
    if (!spent) continue;
    const resumeAt = Date.parse(meter.resetsAt);
    if (!Number.isFinite(resumeAt) || resumeAt <= now) continue;
    if (best === null || resumeAt < best.resumeAt) best = { resumeAt, window };
  }
  return best;
}

/** What OpenCode's gateway calls a usage limit in a quota message. */
export const OPENCODE_USAGE_LIMIT = /GoUsageLimitError|OpenCode Go usage limit/i;

/** The header the OpenCode gateway uses to keep one conversation on one route. */
export const OPENCODE_SESSION_HEADER = "x-opencode-session";

/**
 * Reads `{base}/usage` with the route's own key. Any answer that is not a usage
 * document (another provider's 404, an expired key, a timeout) yields null, and the
 * router falls back to its fixed cooldown.
 */
export async function fetchUsageResume(input: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetchImpl?: typeof fetch;
  readonly now: number;
  readonly timeoutMs?: number;
}): Promise<UsageResume | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 5_000);
  try {
    const response = await (input.fetchImpl ?? globalThis.fetch)(
      `${input.baseUrl.replace(/\/+$/, "")}/usage`,
      {
        headers: { authorization: `Bearer ${input.apiKey}`, ...input.headers },
        signal: controller.signal,
      },
    );
    if (!response.ok) return null;
    return usageResumeOf(await response.json(), input.now);
  } finally {
    clearTimeout(timer);
  }
}
