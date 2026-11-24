import { z } from "zod";
import { EntrySchema, type PartSchema, SessionSchema } from "../../src/core/contracts";
export { EntrySchema, SessionSchema };
export type Session = z.infer<typeof SessionSchema>;
export type Part = z.infer<typeof PartSchema>;
export type Entry = z.infer<typeof EntrySchema>;

export function apiUrl(path: string): string {
  const base = window.location.pathname.startsWith("/app2") ? "/app2" : "";
  return `${base}${path}`;
}

export async function getJson<T>(url: string, schema: z.ZodType<T>): Promise<T> {
  const response = await fetch(apiUrl(url));
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return schema.parse(await response.json());
}

export function postJson(url: string, body: unknown): Promise<unknown>;
export function postJson<T>(url: string, body: unknown, schema: z.ZodType<T>): Promise<T>;
export function postJson(url: string, body: unknown, schema: z.ZodType = z.unknown()): Promise<unknown> {
  return sendJson("POST", url, body, schema);
}

export function sendJson(method: string, url: string, body?: unknown): Promise<unknown>;
export function sendJson<T>(method: string, url: string, body: unknown, schema: z.ZodType<T>): Promise<T>;
export async function sendJson(method: string, url: string, body?: unknown, schema: z.ZodType = z.unknown()): Promise<unknown> {
  const init: RequestInit =
    body === undefined
      ? { method }
      : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const response = await fetch(apiUrl(url), init);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return schema.parse(await response.json());
}
