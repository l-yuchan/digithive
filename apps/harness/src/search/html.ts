const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    const lower = body.toLowerCase();
    if (lower.startsWith("#x")) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (lower.startsWith("#")) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[lower] ?? whole;
  });
}

export function stripTags(value: string): string {
  return decodeEntities(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function attribute(attrs: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(attrs);
  return match ? (match[1] ?? match[2] ?? null) : null;
}

function hasClass(attrs: string, name: string): boolean {
  return (attribute(attrs, "class") ?? "").split(/\s+/).includes(name);
}

/** Decode a DuckDuckGo result href, including the uddg redirect target. */
export function duckDuckGoTarget(href: string): string | null {
  const decoded = decodeEntities(href);
  let url: URL;
  try {
    url = new URL(decoded, "https://duckduckgo.com");
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
  const uddg = url.searchParams.get("uddg");
  const candidate = uddg ?? (url.hostname.endsWith("duckduckgo.com") ? null : decoded);
  if (!candidate) return null;
  try {
    const target = new URL(candidate);
    return target.protocol === "http:" || target.protocol === "https:" ? target.toString() : null;
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

export type DuckDuckGoPage = {
  readonly blocked: boolean;
  readonly results: { readonly title: string; readonly url: string; readonly snippet: string }[];
};

const ANCHOR = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
const SNIPPET =
  /<(?:a|div)\b[^>]*class\s*=\s*(?:"[^"]*result__snippet[^"]*"|'[^']*result__snippet[^']*')[^>]*>([\s\S]*?)<\/(?:a|div)>/gi;

/** Parses the best-effort HTML endpoint. No hydration or page fetches beyond this body. */
export function parseDuckDuckGoHtml(html: string): DuckDuckGoPage {
  const blocked = /anomaly|unusual traffic|captcha|bot detection/i.test(html);
  const titles: { index: number; title: string; url: string }[] = [];
  for (const match of html.matchAll(ANCHOR)) {
    const attrs = match[1] ?? "";
    if (!hasClass(attrs, "result__a")) continue;
    const href = attribute(attrs, "href");
    if (!href) continue;
    const url = duckDuckGoTarget(href);
    if (!url) continue;
    const title = stripTags(match[2] ?? "");
    if (!title) continue;
    titles.push({ index: match.index, title, url });
  }
  const snippets: { index: number; text: string }[] = [];
  for (const match of html.matchAll(SNIPPET)) {
    snippets.push({ index: match.index, text: stripTags(match[1] ?? "") });
  }
  const results = titles.map((title, position) => {
    const next = titles[position + 1]?.index ?? Number.POSITIVE_INFINITY;
    const snippet = snippets.find((item) => item.index > title.index && item.index < next);
    return { title: title.title, url: title.url, snippet: snippet?.text ?? "" };
  });
  return { blocked, results };
}
