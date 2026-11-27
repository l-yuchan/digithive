import type { WhiteboardKind } from "./whiteboardApi";

export const KIND_LABELS: Record<WhiteboardKind, string> = {
  record: "기록",
  thread: "노트",
  commitment: "할 일",
  watch: "주시",
};

const STATUS_LABELS: Record<string, string> = {
  active: "활성",
  live: "현재",
  published: "발행됨",
  queued: "대기",
  running: "실행 중",
  succeeded: "완료",
  failed: "실패",
  interrupted: "중단됨",
  awaiting_approval: "승인 대기",
  archived: "보관됨",
  open: "열림",
  in_progress: "진행 중",
  done: "완료",
  cancelled: "취소됨",
  current: "현재",
  superseded: "이전 기록",
  enabled: "사용 중",
  disabled: "사용 안 함",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function sourceLabel(source: Readonly<Record<string, unknown>>): string {
  const entries = Object.entries(source);
  if (entries.length === 0) return "사용자 작성";
  const type = typeof source["type"] === "string" ? source["type"] : null;
  const id = typeof source["id"] === "string" ? source["id"] : null;
  const labels: Record<string, string> = {
    gmail: "Gmail",
    calendar: "캘린더",
    canvas: "Canvas",
    file: "파일",
    memory: "기억",
    workflow: "워크플로",
    run: "실행",
    schedule: "스케줄",
    briefing: "브리핑",
    web_search: "웹 검색",
    user: "사용자",
    agent: "에이전트",
  };
  if (type || id) return [type ? (labels[type] ?? type) : null, id].filter(Boolean).join(" / ");
  return JSON.stringify(source);
}
