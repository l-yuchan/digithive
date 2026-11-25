import { describe, expect, test } from "bun:test";
import { parseTitle, titleMaterial, TITLE_INSTRUCTION } from "../src/workflows/title";

/**
 * The title run's two pure pieces: the bounded material a model reads, and the strict
 * reading of its reply. Both are tested because a bad reply must never become a name
 * (the run leaves the default title and records `session.title_failed`).
 */
describe("parseTitle", () => {
  test("accepts one JSON object, bare or fenced or inside prose", () => {
    expect(parseTitle('{"title":"회의 일정 정리"}')).toBe("회의 일정 정리");
    expect(parseTitle('```json\n{"title":"회의 일정 정리"}\n```')).toBe("회의 일정 정리");
    expect(parseTitle('제목입니다: {"title":"회의 일정 정리"} 입니다')).toBe("회의 일정 정리");
  });

  test("cleans quotes, markdown heading and a trailing period", () => {
    expect(parseTitle('{"title":"\\"회의 일정\\""}')).toBe("회의 일정");
    expect(parseTitle('{"title":"# 회의 일정"}')).toBe("회의 일정");
    expect(parseTitle('{"title":"회의 일정."}')).toBe("회의 일정");
  });

  test("refuses what is not a name", () => {
    expect(parseTitle("")).toBeNull();
    expect(parseTitle("그냥 문장입니다")).toBeNull();
    expect(parseTitle('{"title":""}')).toBeNull();
    expect(parseTitle('{"title":"   "}')).toBeNull();
    expect(parseTitle('{"title":"한 줄이\\n아닌 제목"}')).toBeNull();
    expect(parseTitle(`{"title":"${"가".repeat(41)}"}`)).toBeNull();
    expect(parseTitle('{"title":"새 대화"}')).toBeNull();
    expect(parseTitle('{"title":"첫 대화"}')).toBeNull();
    expect(parseTitle('{"title":"분기 대화"}')).toBeNull();
    expect(parseTitle('{"name":"회의"}')).toBeNull();
  });
});

describe("titleMaterial", () => {
  test("labels each part and omits the empty ones", () => {
    const text = titleMaterial({ question: "회의 준비물?", thinking: "", answer: "", tools: [] });
    expect(text).toBe("질문: 회의 준비물?");
    expect(titleMaterial({ question: "", thinking: "", answer: "", tools: [] })).toBe("");
  });

  test("bounds every part and dedupes the tools", () => {
    const text = titleMaterial({
      question: "가".repeat(1_500),
      thinking: "나".repeat(400),
      answer: "다".repeat(600),
      tools: ["gmail_search", "gmail_search", ...Array.from({ length: 20 }, (_, i) => `t${i}`)],
    });
    expect(text).toContain(`질문: ${"가".repeat(1_000)}…`);
    expect(text).toContain(`생각: ${"나".repeat(300)}…`);
    expect(text).toContain(`답변: ${"다".repeat(500)}…`);
    expect(text.match(/gmail_search/g)?.length).toBe(1);
    expect(text.split("도구: ")[1]?.split(", ").length).toBe(10);
  });
});

test("the instruction asks for one JSON line and allows an empty title", () => {
  expect(TITLE_INSTRUCTION).toContain('{"title": "..."}');
  expect(TITLE_INSTRUCTION).toContain('{"title":""}');
});
