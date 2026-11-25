import { describe, expect, test } from "bun:test";
import { BRAILLE_FRAMES, elapsedLabel, spinnerFrame, spinnerText } from "../web/src/spinner";
import {
  TOOL_RESULT_LIMIT,
  TOOL_PREVIEW_CHARS,
  formatToolArguments,
  formatToolResult,
  resultBytes,
  sizeLabel,
  toolResultBody,
} from "../web/src/formatTool";
import { safeHref } from "../web/src/markdown";

/** The frame at an index the test knows exists, without asserting it. */
function frame(index: number): string {
  const value = BRAILLE_FRAMES[index];
  if (value === undefined) throw new Error(`no frame ${index}`);
  return value;
}

function prettyOf(view: { readonly pretty: string | null }): string {
  if (view.pretty === null) throw new Error("expected JSON to be pretty-printed");
  return view.pretty;
}

describe("the braille spinner", () => {
  test("advances one frame per 80ms and cycles", () => {
    expect(spinnerFrame(0)).toBe(frame(0));
    expect(spinnerFrame(79)).toBe(frame(0));
    expect(spinnerFrame(80)).toBe(frame(1));
    expect(spinnerFrame(80 * BRAILLE_FRAMES.length)).toBe(frame(0));
    expect(spinnerFrame(-5)).toBe(frame(0));
  });

  test("reduced motion keeps one still character", () => {
    expect(spinnerText(0, true)).toBe("⠿");
    expect(spinnerText(5_000, true)).toBe("⠿");
    expect(spinnerText(80, false)).toBe(frame(1));
  });

  test("elapsed time never goes negative and rolls over to minutes", () => {
    expect(elapsedLabel(1_000, 1_000)).toBe("0초");
    expect(elapsedLabel(1_000, 1_999)).toBe("0초");
    expect(elapsedLabel(1_000, 4_000)).toBe("3초");
    expect(elapsedLabel(0, 65_000)).toBe("1분 05초");
    expect(elapsedLabel(5_000, 1_000)).toBe("0초");
  });
});

describe("a tool result", () => {
  test("JSON is pretty-printed, and raw keeps the original text", () => {
    const view = formatToolResult('{"name":"회의","n":1}');
    expect(view.pretty).toBe('{\n  "name": "회의",\n  "n": 1\n}');
    expect(view.raw).toBe('{"name":"회의","n":1}');
    expect(view.truncated).toBe(false);
    expect(toolResultBody(view, true)).toBe(prettyOf(view));
    expect(toolResultBody(view, false)).toBe(view.raw);
  });

  test("plain text has nothing to pretty-print", () => {
    const view = formatToolResult("도구 실행 실패: 연결이 거부되었습니다.");
    expect(view.pretty).toBeNull();
    expect(toolResultBody(view, true)).toBe(view.raw);
    expect(formatToolResult("").pretty).toBeNull();
    expect(formatToolResult("{not json").pretty).toBeNull();
    expect(formatToolResult("42").pretty).toBeNull();
  });

  test("a result over the limit is cut with a count of what is missing", () => {
    const huge = `${"[".padEnd(1)}${"가".repeat(TOOL_RESULT_LIMIT)}`;
    const view = formatToolResult(huge);
    expect(view.truncated).toBe(true);
    expect(view.raw.length).toBe(TOOL_PREVIEW_CHARS);
    expect(view.hiddenChars).toBe(huge.length - TOOL_PREVIEW_CHARS);
    expect(view.pretty).toBeNull();
    expect(toolResultBody(view, true)).toContain("원본은 도구 결과로 보존됩니다");
  });

  test("the size label reports bytes and, for a cut result, the preview length", () => {
    const small = formatToolResult("abc");
    expect(sizeLabel(small, 3)).toBe("3B");
    expect(sizeLabel(small, 1_234)).toBe("1.2KB");
    const cut = formatToolResult("가".repeat(TOOL_RESULT_LIMIT + 10));
    expect(sizeLabel(cut, resultBytes("가".repeat(TOOL_RESULT_LIMIT + 10)))).toContain("자만 표시");
  });

  test("arguments are pretty-printed only when they are JSON", () => {
    expect(formatToolArguments('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(formatToolArguments("")).toBe("");
    expect(formatToolArguments("raw text")).toBe("raw text");
  });
});

describe("markdown links", () => {
  test("only web and mail schemes survive", () => {
    expect(safeHref("https://example.com")).toBe("https://example.com");
    expect(safeHref("mailto:a@b.c")).toBe("mailto:a@b.c");
    expect(safeHref("#section")).toBe("#section");
    expect(safeHref("/chat/x")).toBe("/chat/x");
    expect(safeHref("a/b")).toBe("a/b");
    expect(safeHref("javascript:alert(1)")).toBeUndefined();
    expect(safeHref("JavaScript:alert(1)")).toBeUndefined();
    expect(safeHref("data:text/html,x")).toBeUndefined();
    expect(safeHref(undefined)).toBeUndefined();
    expect(safeHref("  ")).toBeUndefined();
  });
});
