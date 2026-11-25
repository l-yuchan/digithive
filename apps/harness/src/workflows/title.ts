/**
 * What a fresh conversation is named, once its first answer exists.
 *
 * The name comes from a one-off model run instead of a rule, because a good title is
 * a short judgement about a conversation. The instruction asks for one JSON line so
 * parsing never has to guess, and an empty title is a valid answer when the material
 * is too thin to name.
 */
export const TITLE_WORKFLOW_KEY = "system:title";

export const TITLE_INSTRUCTION = [
  "너는 대화에 붙일 이름을 짓는다. 다음 자료를 읽고, 이 대화가 무엇에 대한 것인지 나타내는",
  "한국어 제목을 하나 고른다.",
  "",
  "규칙:",
  '- 정확히 한 줄의 JSON으로만 답한다: {"title": "..."}',
  "- 제목은 8~24자, 따옴표·마크다운·이모지·마침표 없이.",
  "- 질문하는 행위(예: '질문', '대화')가 아니라 주제를 적는다.",
  "- 다른 설명, 코드 블록, 앞뒤 문장을 붙이지 않는다.",
  '- 자료가 너무 적어 이름을 지을 수 없으면 {"title":""}로 답한다.',
].join("\n");

const DEFAULT_NAMES = new Set(["새 대화", "첫 대화", "분기 대화"]);
const MAX_TITLE = 40;

function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit)}…`;
}

/** The bounded excerpt the title run reads: the question, the reasoning, the answer, the tools. */
export function titleMaterial(input: {
  readonly question: string;
  readonly thinking: string;
  readonly answer: string;
  readonly tools: readonly string[];
}): string {
  const lines: string[] = [];
  const question = clip(input.question, 1000);
  if (question.length > 0) lines.push(`질문: ${question}`);
  const thinking = clip(input.thinking, 300);
  if (thinking.length > 0) lines.push(`생각: ${thinking}`);
  const answer = clip(input.answer, 500);
  if (answer.length > 0) lines.push(`답변: ${answer}`);
  const tools = [...new Set(input.tools)].slice(0, 10);
  if (tools.length > 0) lines.push(`도구: ${tools.join(", ")}`);
  return lines.join("\n");
}

function fromObject(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const title = (parsed as { title?: unknown }).title;
  return typeof title === "string" ? title : null;
}

/** Accepts bare JSON, a fenced JSON block, or one JSON object inside prose. */
function extractJson(reply: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(reply);
  if (fenced?.[1] !== undefined) {
    const inside = fromObject(fenced[1].trim());
    if (inside !== null) return inside;
  }
  const bare = fromObject(reply.trim());
  if (bare !== null) return bare;
  const objects = reply.match(/\{[^{}]*\}/g) ?? [];
  for (const candidate of objects) {
    const found = fromObject(candidate);
    if (found !== null) return found;
  }
  return null;
}

function clean(title: string): string {
  let value = title.trim();
  for (const wrapper of ['"', "'", "`"]) {
    if (value.startsWith(wrapper) && value.endsWith(wrapper) && value.length > 1)
      value = value.slice(1, -1).trim();
  }
  value = value.replace(/^#+\s*/, "").trim();
  if (value.endsWith(".") || value.endsWith("。")) value = value.slice(0, -1).trim();
  return value;
}

/** The title a model reply names, or null when the reply cannot be a usable name. */
export function parseTitle(reply: string): string | null {
  if (reply.trim().length === 0) return null;
  const raw = extractJson(reply);
  if (raw === null) return null;
  const title = clean(raw);
  if (title.length === 0) return null;
  if (title.length > MAX_TITLE) return null;
  if (/[\r\n]/.test(title)) return null;
  if (DEFAULT_NAMES.has(title)) return null;
  return title;
}
