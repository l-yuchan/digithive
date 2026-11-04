import { ZodError, type ZodType } from "zod";
import type { ApiError } from "../shared";
import type { Store } from "./store";

// HTTP plumbing shared by all route modules: error mapping (contract §5),
// JSON body validation through the shared zod schemas, and query-param
// helpers. Note: the ApiError code set has no code for rejected cross-site
// requests; the server answers those with 403 + validation_error (documented
// in the handoff).

export type ApiErrorCode = ApiError["error"]["code"];

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (details: unknown, message = "validation failed"): HttpError =>
  new HttpError(400, "validation_error", message, details);
export const notFound = (message = "not found"): HttpError => new HttpError(404, "not_found", message);
export const invalidTransition = (message: string): HttpError =>
  new HttpError(409, "invalid_transition", message);
export const conflict = (message: string): HttpError => new HttpError(409, "conflict", message);

export interface CtxDeps {
  store: Store;
  now: () => Date;
  backupDir: string;
}

export interface Ctx extends CtxDeps {
  url: URL;
  params: Record<string, string>;
  req: Request;
}

export type Reply = { status?: number; body?: unknown } | Response;

export interface Route {
  method: string;
  path: string;
  handler: (ctx: Ctx) => Promise<Reply>;
}

export interface CompiledRoute extends Route {
  keys: string[];
  re: RegExp;
}

export function jsonReply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) {
    const err: ApiError["error"] = { code: e.code, message: e.message };
    if (e.details !== undefined) err.details = e.details;
    return jsonReply(e.status, { error: err });
  }
  if (e instanceof ZodError) {
    return jsonReply(400, {
      error: {
        code: "validation_error",
        message: "validation failed",
        details: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
    });
  }
  return jsonReply(500, { error: { code: "internal_error", message: String(e) } });
}

export async function readBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  const raw = await req.text();
  if (raw.trim() === "") throw badRequest([{ path: "body", message: "a JSON request body is required" }]);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    throw badRequest([{ path: "body", message: "malformed JSON body" }]);
  }
  try {
    return schema.parse(parsedJson);
  } catch (e) {
    if (e instanceof ZodError) {
      throw badRequest(e.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    }
    throw e;
  }
}

export function parsePagination(url: URL): { limit: number; offset: number } {
  const out = { limit: 50, offset: 0 };
  const limitRaw = url.searchParams.get("limit");
  const offsetRaw = url.searchParams.get("offset");
  if (limitRaw !== null) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1 || n > 200) throw badRequest([{ path: "limit", message: "limit must be an integer 1..200" }]);
    out.limit = n;
  }
  if (offsetRaw !== null) {
    const n = Number(offsetRaw);
    if (!Number.isInteger(n) || n < 0) throw badRequest([{ path: "offset", message: "offset must be an integer >= 0" }]);
    out.offset = n;
  }
  return out;
}

export function enumParam<T extends string>(url: URL, name: string, allowed: readonly T[]): T | null {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return null;
  if (!allowed.includes(raw as T)) {
    throw badRequest([{ path: name, message: `must be one of ${allowed.join(", ")}` }]);
  }
  return raw as T;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function isIsoDateTime(v: unknown): v is string {
  return typeof v === "string" && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));
}

export function requireIso(value: unknown, path: string): string {
  if (!isIsoDateTime(value)) throw badRequest([{ path, message: "must be an ISO-8601 datetime" }]);
  return value;
}

export function isLocalDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  return !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
}

export function requireLocalDate(value: unknown, path: string): string {
  if (!isLocalDate(value)) throw badRequest([{ path, message: "must be a YYYY-MM-DD date" }]);
  return value;
}

export function requireTimeOfDay(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw badRequest([{ path, message: "must be an HH:MM time of day" }]);
  }
  return value;
}
