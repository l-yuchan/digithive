import { z } from "zod";

export type ProviderErrorKind =
  | "http_4xx"
  | "http_5xx"
  | "rate_limited"
  | "quota_exhausted"
  | "auth_expired"
  | "timeout"
  | "transport"
  | "malformed"
  | "truncated"
  | "empty_output"
  | "aborted";

/** Failures that say nothing about the route's health; retrying elsewhere is safe. */
const TRANSIENT: ReadonlySet<ProviderErrorKind> = new Set([
  "rate_limited",
  "timeout",
  "transport",
  "http_5xx",
]);

/** Failures that stay true for a while: the route is suspended, not retried. */
const UNHEALTHY: ReadonlySet<ProviderErrorKind> = new Set(["quota_exhausted", "auth_expired"]);

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    readonly status?: number,
    /** Upstream diagnostics text (error message, type, code), for the owner's eyes. */
    readonly detail?: string,
    /** Upstream response body as received, for the execution log. */
    readonly body?: string,
  ) {
    super(detail ? `${kind} (HTTP ${status ?? "?"}): ${detail}` : kind);
    this.name = "ProviderError";
  }

  get transient(): boolean {
    return TRANSIENT.has(this.kind);
  }

  get unhealthy(): boolean {
    return UNHEALTHY.has(this.kind);
  }
}

const ErrorEnvelope = z.object({ error: z.unknown().nonoptional() });
const ErrorFields = z.object({
  status: z.union([z.number(), z.string()]).optional(),
  code: z.union([z.string(), z.number()]).nullish(),
  type: z.string().nullish(),
  message: z.string().optional(),
});

/** Usage-limit wording seen in real provider replies, e.g. "OpenCode Go usage limit reached". */
const QUOTA =
  /insufficient[_ ](?:quota|credits|balance)|usage[_ ]limit|quota[_ ](?:exceeded|exhausted|reached)|credits?[_ ](?:exceeded|exhausted)|out of quota|exceeded.{0,30}quota|billing_hard_limit/i;

/**
 * Classify a non-2xx response or an in-stream error frame. `status` is the HTTP
 * status this request received; `parsed` may be JSON or a plain text body.
 */
export function responseError(status: number, body: string, parsed: unknown): ProviderError {
  const envelope = ErrorEnvelope.safeParse(parsed);
  const detail = envelope.success ? envelope.data.error : parsed;
  const fields = ErrorFields.safeParse(detail).data;
  const description = fields
    ? [fields.type, fields.code, fields.message].filter(Boolean).join(" ")
    : typeof detail === "string"
      ? detail
      : body;
  return new ProviderError(classify(status, description), status, description, body);
}

export function classify(status: number, description = ""): ProviderErrorKind {
  if (status === 402 || QUOTA.test(description)) return "quota_exhausted";
  if (status === 401 || status === 403 || /invalid_api_key|authentication_error/i.test(description))
    return "auth_expired";
  if (status === 429 || /rate[_ -]?limit/i.test(description)) return "rate_limited";
  if (status === 408 || status === 504) return "timeout";
  if (status >= 500 || /server_error|overloaded_error/i.test(description)) return "http_5xx";
  if (status >= 400) return "http_4xx";
  return "malformed";
}

/** Parse a body that may or may not be JSON without throwing. */
export function decodeBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (error) {
    if (error instanceof SyntaxError) return body;
    throw error;
  }
}
