/**
 * How a tool result is shown: collapsed with a size, and pretty-printed only when it
 * really is JSON. A result that is not JSON has nothing to pretty-print, and a huge one
 * would triple in height, so it is cut to a readable preview instead.
 */

export const TOOL_RESULT_LIMIT = 20_000;
export const TOOL_PREVIEW_CHARS = 4_000;

export type ToolResultView = {
  /** Indented JSON, or null when the result is not JSON (or too big to indent). */
  readonly pretty: string | null;
  /** What is shown as "raw": the original text, or its preview when truncated. */
  readonly raw: string;
  readonly truncated: boolean;
  /** Characters omitted by the preview. */
  readonly hiddenChars: number;
};

export function formatToolResult(detail: string): ToolResultView {
  if (detail.length > TOOL_RESULT_LIMIT) {
    return {
      pretty: null,
      raw: detail.slice(0, TOOL_PREVIEW_CHARS),
      truncated: true,
      hiddenChars: detail.length - TOOL_PREVIEW_CHARS,
    };
  }
  const parsed = parseJson(detail);
  return {
    pretty: parsed === null ? null : JSON.stringify(parsed, null, 2),
    raw: detail,
    truncated: false,
    hiddenChars: 0,
  };
}

function parseJson(detail: string): unknown {
  const trimmed = detail.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/** The text a card shows for the chosen view. */
export function toolResultBody(view: ToolResultView, pretty: boolean): string {
  if (view.truncated)
    return `${view.raw}\n… 외 ${view.hiddenChars.toLocaleString("ko-KR")}자 (원본은 도구 결과로 보존됩니다)`;
  return pretty && view.pretty !== null ? view.pretty : view.raw;
}

/** "1.2KB", and for a cut result how much is missing. */
export function sizeLabel(view: ToolResultView, fullBytes: number): string {
  const size =
    fullBytes < 1_000
      ? `${fullBytes}B`
      : fullBytes < 1_000_000
        ? `${(fullBytes / 1_000).toFixed(1)}KB`
        : `${(fullBytes / 1_000_000).toFixed(1)}MB`;
  if (!view.truncated) return size;
  return `${size} · ${view.raw.length.toLocaleString("ko-KR")}자만 표시`;
}

/** Byte length of the whole result, which the preview no longer holds. */
export function resultBytes(original: string): number {
  return new TextEncoder().encode(original).length;
}

/** Tool arguments as JSON when they are JSON; untouched otherwise. */
export function formatToolArguments(detail: string): string {
  if (detail.trim().length === 0) return "";
  try {
    return JSON.stringify(JSON.parse(detail), null, 2);
  } catch {
    return detail;
  }
}
