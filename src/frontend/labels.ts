import type { EntryKind, EntryStatus, PreferenceKey, SuggestionStatus } from "../shared/types";

export const OFFLINE_NOTICE = "Offline rule-based mode: retrieval and suggestion triage use deterministic keyword/overlap heuristics over your saved entries and sources. They cannot understand meaning beyond these heuristics, may miss relevant connections, and may surface superficial matches. Every suggestion shows the stored evidence that produced it. No AI model is used in this mode.";
export const N1_DISCLAIMER = "n=1 experience probe: these numbers describe one person's month and cannot establish generalization, causality, or suitability for other users. Components, misses, and critical events are reported raw; no benchmark claim is made.";
export const KIND_LABELS: Record<EntryKind, string> = { interest: "관심", fact: "확인한 사실", hypothesis: "가설", commitment: "약속", delegation: "위임" };
/**
 * What each note kind actually does. Shown under the kind picker and as the
 * hover/tap hint on every option, because the difference between the five
 * kinds is the part people could not guess from the labels alone.
 */
export const KIND_HELP: Record<EntryKind, string> = {
  interest: "지금 결정하지 않아도 되는 주제입니다. 나중에 연결되는 자료가 생기면 그때 알려 주고, 스스로 약속이 되지는 않습니다.",
  fact: "이미 확인한 내용입니다. 제안의 근거로 인용되며, 근거가 바뀌지 않는 한 스스로 바뀌지 않습니다.",
  hypothesis: "아직 확인되지 않은 생각입니다. 틀렸다고 판단할 근거를 함께 적어 두고, 판단은 직접 합니다.",
  commitment: "기한이 있는 일입니다. 기한이 지나도 자동으로 완료 처리하지 않고, 취소하거나 미룰 수 있습니다.",
  delegation: "이 기기 안의 기록만 사용해 준비를 시키는 요청입니다. 외부로 나가지 않고 외부 일정도 바꾸지 않습니다.",
};
export const STATUS_LABELS: Record<EntryStatus, string> = { active: "활성", paused: "일시정지", withdrawn: "추적 중단", completed: "완료", cancelled: "일정 취소" };
export const SUGGESTION_STATUS_LABELS: Record<SuggestionStatus, string> = { queued: "조용히 보관", held: "보류", surfaced: "살펴 볼 제안", accepted: "수락", dismissed: "닫음", deferred: "나중에", expired: "만료" };
export const PREFERENCE_LABELS: Record<PreferenceKey, string> = { report_style: "설명 방식", interruption: "알림 시점", delivery: "전달 방식", proactivity: "능동성" };
export const INTERRUPTION_LABELS = { never: "알리지 않음", digest_only: "다이제스트만", when_strong: "강한 연결만", immediate: "즉시" } as const;
export const ROUTE_LABELS = { today: "오늘", calendar: "일정", entries: "내 기록", sources: "자료와 변화", review: "제안 검토", evaluation: "한 달 일지", settings: "설정", history: "기록 · 백업" } as const;
export const EFFORT_FIELDS = [
  ["context_recovery_minutes", "맥락 복원", "이전 맥락을 다시 떠올리고 찾는 데 쓴 분"],
  ["search_minutes", "검색", "필요한 기록과 자료를 찾는 데 쓴 분"],
  ["task_restart_minutes", "작업 재시작", "중단된 작업으로 돌아가는 데 쓴 분"],
  ["review_correction_minutes", "검토와 수정", "제안의 근거를 확인하고 바로잡는 데 쓴 분"],
  ["assistant_management_minutes", "비서 관리", "비서를 설정하고 관리하는 데 쓴 분"],
  ["interruption_recovery_minutes", "방해 후 복귀", "원치 않은 알림에서 복귀하는 데 쓴 분"],
] as const;
export const COUNT_FIELDS = [
  ["opportunities_offered", "받은 기회"], ["opportunities_accepted", "받아들인 기회"],
  ["missed_high_value", "놓친 중요 기회"], ["unwanted_interruptions", "원치 않은 방해"],
  ["grounding_errors", "근거 오류"], ["correction_events", "수정 횟수"],
  ["cancellation_violations", "취소·중단 위반"], ["approval_boundary_violations", "승인 경계 위반"],
] as const;
export const RATING_FIELDS = [["usefulness_rating", "유용성"], ["burden_rating", "부담"], ["control_rating", "통제감"], ["confidence_rating", "신뢰"]] as const;
