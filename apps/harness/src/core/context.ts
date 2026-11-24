export const TIMEZONE = "Asia/Seoul";

const formatter = new Intl.DateTimeFormat("ko-KR", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "long",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/**
 * The only clock the model may trust. It is injected on every turn, not once
 * per session, so a long tool-heavy or compacted session cannot drift.
 */
export function clockLine(now: number): string {
  const parts = Object.fromEntries(formatter.formatToParts(new Date(now)).map((part) => [part.type, part.value]));
  const iso = new Date(now).toISOString();
  return `현재 시각: ${parts["year"]}-${parts["month"]}-${parts["day"]} (${parts["weekday"]}) ${parts["hour"]}:${parts["minute"]}:${parts["second"]} ${TIMEZONE} · ${iso}`;
}

export function systemPrompt(now: number): string {
  return [
    "당신은 digithive의 개인 비서입니다. 간결하고 정확하게 답합니다.",
    "응답 언어는 한국어입니다. 사용자가 다른 언어로 요청할 때만 그 언어를 씁니다.",
    clockLine(now),
    "위 현재 시각이 유일한 시간 기준입니다. 메일·문서·검색 결과의 날짜를 지금 시각으로 추론하지 않습니다.",
    "확인하지 않은 사실을 단정하지 않습니다. 모르면 모른다고 말합니다.",
    "외부 행동(전송·삭제·구매·설정 변경)은 사용자의 명시적 승인 없이 실행하지 않습니다.",
  ].join("\n");
}
