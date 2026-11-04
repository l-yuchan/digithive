// Optional LLM assistance is OMITTED from this build (lead override): the
// product runs in offline_rules mode only. This module keeps the contract §9
// adapter shape and the exact honesty notices so capabilities reporting stays
// truthful. No code path may call complete(); triage, scoring, delivery, dedup
// and explanations are always deterministic rules (matcher: "rules").

export interface LlmAdapter {
  readonly enabled: boolean;
  complete(req: {
    system: string;
    user: string;
    max_tokens: number;
  }): Promise<{ text: string; model: string }>;
}

/** Exact contract §9 notice (verbatim). */
export const OFFLINE_LIMITATIONS_NOTICE =
  "Offline rule-based mode: retrieval and suggestion triage use deterministic " +
  "keyword/overlap heuristics over your saved entries and sources. They cannot " +
  "understand meaning beyond these heuristics, may miss relevant connections, and may " +
  "surface superficial matches. Every suggestion shows the stored evidence that produced " +
  "it. No AI model is used in this mode.";

/** Honest Korean limitation addendum (lead requirement). */
export const KOREAN_LIMITATION_NOTICE =
  "정직한 안내: 이 모드는 AI 모델을 사용하지 않습니다. 저장된 기록 위의 결정론적 키워드 규칙만으로 " +
  "검색과 제안을 만들며, 의미를 이해하지 못해 관련 연결을 놓치거나 표면적 일치를 내보낼 수 있습니다. " +
  "모든 제안은 저장된 근거와 함께 표시됩니다.";

export const LIMITATIONS_NOTICE = `${OFFLINE_LIMITATIONS_NOTICE}\n\n${KOREAN_LIMITATION_NOTICE}`;

export const QUERY_LIMITATIONS =
  "Rule-based keyword retrieval over saved records only; matches may be missed or superficial. No AI model is used.";

export const disabledLlm: LlmAdapter = {
  enabled: false,
  async complete(): Promise<{ text: string; model: string }> {
    throw new Error("LLM assistance is omitted in this offline build");
  },
};

export function llmStatus(): {
  mode: "offline_rules";
  llm: { enabled: boolean; provider: string | null; model: string | null };
} {
  return { mode: "offline_rules", llm: { enabled: false, provider: null, model: null } };
}
