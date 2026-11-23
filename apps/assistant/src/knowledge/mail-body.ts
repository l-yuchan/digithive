import { z } from "zod";

const payloadBase = z.object({
  mimeType: z.string().optional(),
  filename: z.string().optional(),
  headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
  body: z.object({ data: z.string().optional(), size: z.number().optional() }).optional(),
});
export type Payload = z.infer<typeof payloadBase> & { readonly parts?: readonly Payload[] | undefined };
export const Payload: z.ZodType<Payload> = payloadBase.extend({
  parts: z.array(z.lazy(() => Payload)).optional(),
});

export const GmailMessage = z.object({
  id: z.string(),
  threadId: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
  internalDate: z.string().optional(),
  snippet: z.string().optional(),
  payload: Payload.optional(),
});
export type GmailMessage = z.infer<typeof GmailMessage>;

const MAX_BODY_CHARS = 40_000;

function decode(data: string | undefined): string {
  if (!data) return "";
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.from(data, "base64url"));
}

/** HTML is reduced to text: tags, scripts and styles are removed and entities
 * decoded. Nothing is rendered or executed, and a quoted instruction inside a
 * mail stays plain data. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function walk(payload: Payload, collected: { plain: string[]; html: string[] }): void {
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    collected.plain.push(decode(payload.body.data));
  } else if (payload.mimeType === "text/html" && payload.body?.data) {
    collected.html.push(decode(payload.body.data));
  }
  for (const part of payload.parts ?? []) walk(part, collected);
}

export type ExtractedMail = {
  readonly subject: string;
  readonly from: string;
  readonly to: string;
  readonly date: string;
  readonly text: string;
  readonly truncated: boolean;
  readonly hasHtmlOnly: boolean;
};

export function header(payload: Payload | undefined, name: string): string {
  const found = payload?.headers?.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
  return found?.value ?? "";
}

/** Prefers the plain-text part; falls back to reduced HTML. The result is data
 * only, bounded in size. */
export function extractMail(message: GmailMessage): ExtractedMail {
  const collected = { plain: [] as string[], html: [] as string[] };
  if (message.payload) walk(message.payload, collected);
  const htmlOnly = collected.plain.length === 0 && collected.html.length > 0;
  const text = (collected.plain.length > 0 ? collected.plain.join("\n") : collected.html.map(htmlToText).join("\n"))
    .replace(/\r\n/g, "\n")
    .trim();
  return {
    subject: header(message.payload, "Subject") || message.snippet || "(제목 없음)",
    from: header(message.payload, "From"),
    to: header(message.payload, "To"),
    date: header(message.payload, "Date"),
    text: text.slice(0, MAX_BODY_CHARS),
    truncated: text.length > MAX_BODY_CHARS,
    hasHtmlOnly: htmlOnly,
  };
}
