export function safeHref(href: string | undefined): string | undefined {
  if (href === undefined) return undefined;
  const value = href.trim();
  if (value.length === 0) return undefined;
  if (/^(\/|\.\/|\.\.\/|#)/.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value))
    return MARKDOWN_ALLOWED_PROTOCOLS.includes(value.slice(0, value.indexOf(":") + 1).toLowerCase())
      ? value
      : undefined;
  return value;
}

export const MARKDOWN_ALLOWED_PROTOCOLS: readonly string[] = ["http:", "https:", "mailto:"];
