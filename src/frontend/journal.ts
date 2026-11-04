import { api } from "./api-client";
import { COUNT_FIELDS, EFFORT_FIELDS, RATING_FIELDS } from "./labels";
import { field, html, localDate, text, nullableNumber, numberValue, errorMessage, downloadJson, confirmAction, openDialog, formatDate } from "./dom";
import type { EvaluationEntryInput, HistoryEvent } from "../shared";

function historyLabel(event: HistoryEvent): string {
  const entity: Record<string, string> = { entry: "기록", source: "출처", development: "변화", suggestion: "제안", preparation: "로컬 준비", preference: "선호", settings: "설정", evaluation: "일지", system: "시스템" };
  const action: Record<string, string> = { created: "추가", corrected: "정정", updated: "변경", paused: "일시정지", resumed: "재개", withdrawn: "추적 중단", schedule_cancelled: "일정 취소", promoted: "명시적 승격", surfaced: "제시", queued: "조용히 보관", held: "보류", deferred: "다음으로 미룸", accepted: "수락", dismissed: "거절", expired: "만료", deleted: "삭제", explored: "준비 요청", completed: "완료", stopped: "중단" };
  return `${entity[event.entity_type] ?? "시스템"} · ${action[event.action] ?? "상태 변경"}`;
}

export async function journalView(el: HTMLElement): Promise<void> {
  el.innerHTML = `<h1>한 달 일지</h1><p>빈 시간 값은 미측정입니다. 실제 0분인 경우에만 0을 입력하세요.</p><form class="stack" id="diary">${field("date", "기록 날짜", { type: "date", value: localDate(), required: true })}<label>비교 조건<select name="condition"><option value="baseline">기준선 · 기존 도구</option><option value="secretary">인지 비서 사용</option></select></label><button class="button" type="button" id="load-diary">이 날짜 기록 불러오기</button><h2>사용자 노력 (분)</h2><div class="form-grid">${EFFORT_FIELDS.map(([key, label, hint]) => field(key, label, { type: "number", min: 0, step: 0.1, hint })).join("")}</div><h2>기회와 실패 (횟수)</h2><div class="form-grid">${COUNT_FIELDS.map(([key, label]) => field(key, label, { type: "number", min: 0, step: 1, value: 0 })).join("")}</div><h2>체감 평가</h2><div class="form-grid">${RATING_FIELDS.map(([key, label]) => field(key, `${label} (1~5, 미측정은 빈칸)`, { type: "number", min: 1, max: 5, step: 1 })).join("")}</div>${field("notes", "비교 작업 · 놓친 기회 · 오류와 통제감", { type: "textarea" })}<button class="button button-primary">일지 저장</button><p id="diary-status" role="status"></p></form><h2>기간 비교</h2><form id="summary" class="stack">${field("from", "시작 날짜", { type: "date", value: localDate().slice(0, 8) + "01", required: true })}${field("to", "종료 날짜", { type: "date", value: localDate(), required: true })}<button class="button">기간 비교 보기</button></form><div id="summary-result" aria-live="polite"></div>`;
  const diary = el.querySelector<HTMLFormElement>("#diary");
  const status = el.querySelector("#diary-status");
  if (!diary || !status) return;
  el.querySelector("#load-diary")?.addEventListener("click", async () => {
    const f = new FormData(diary);
    try {
      const { entry } = await api.evaluationDaily(text(f, "date"), text(f, "condition") === "secretary" ? "secretary" : "baseline");
      for (const name of [...EFFORT_FIELDS.map(v => v[0]), ...COUNT_FIELDS.map(v => v[0]), ...RATING_FIELDS.map(v => v[0]), "notes"] as const) {
        const control = diary.elements.namedItem(name);
        if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) control.value = String(entry?.[name] ?? (COUNT_FIELDS.some(v => v[0] === name) ? 0 : ""));
      }
      status.textContent = entry ? "저장된 일지를 불러왔습니다." : "이 날짜와 조건의 기록이 없습니다.";
    } catch (error) { status.textContent = errorMessage(error); }
  });
  diary.addEventListener("submit", async event => {
    event.preventDefault();
    const f = new FormData(diary);
    const body: EvaluationEntryInput = {
      condition: text(f, "condition") === "secretary" ? "secretary" : "baseline",
      context_recovery_minutes: nullableNumber(f, "context_recovery_minutes"), search_minutes: nullableNumber(f, "search_minutes"),
      task_restart_minutes: nullableNumber(f, "task_restart_minutes"), review_correction_minutes: nullableNumber(f, "review_correction_minutes"),
      assistant_management_minutes: nullableNumber(f, "assistant_management_minutes"), interruption_recovery_minutes: nullableNumber(f, "interruption_recovery_minutes"),
      opportunities_offered: numberValue(f, "opportunities_offered"), opportunities_accepted: numberValue(f, "opportunities_accepted"),
      missed_high_value: numberValue(f, "missed_high_value"), unwanted_interruptions: numberValue(f, "unwanted_interruptions"),
      grounding_errors: numberValue(f, "grounding_errors"), correction_events: numberValue(f, "correction_events"),
      cancellation_violations: numberValue(f, "cancellation_violations"), approval_boundary_violations: numberValue(f, "approval_boundary_violations"),
      usefulness_rating: nullableNumber(f, "usefulness_rating"), burden_rating: nullableNumber(f, "burden_rating"),
      control_rating: nullableNumber(f, "control_rating"), confidence_rating: nullableNumber(f, "confidence_rating"), notes: text(f, "notes"),
    };
    try { await api.saveEvaluation(text(f, "date"), body); status.textContent = "일지를 저장했습니다."; }
    catch (error) { status.textContent = errorMessage(error); }
  });
  el.querySelector<HTMLFormElement>("#summary")?.addEventListener("submit", async event => {
    event.preventDefault();
    if (!(event.currentTarget instanceof HTMLFormElement)) return;
    const output = el.querySelector("#summary-result");
    if (!output) return;
    try {
      const f = new FormData(event.currentTarget);
      const s = await api.evaluationSummary(text(f, "from"), text(f, "to"));
      const missingLabel = (v: string): string => {
  const effort: Record<string, string> = { context_recovery_minutes: "맥락 복원", search_minutes: "검색", task_restart_minutes: "작업 재시작", review_correction_minutes: "검토·정정", assistant_management_minutes: "비서 관리", interruption_recovery_minutes: "방해 후 복귀" };
  for (const [key, label] of Object.entries(effort)) if (v.includes(key)) return `${label} 미측정`;
  if (v.includes("no evaluation entries")) return "기간 내 일지 없음";
  if (v.includes("no complete baseline")) return "완전한 기준선 일 없음";
  if (v.includes("no complete secretary")) return "완전한 비서 사용일 없음";
  return v;
};
  output.innerHTML = `<h3>일일 총 노력의 중앙값 차이</h3><p>${s.net_time_saved_minutes === null ? "완전한 기준선·비서 사용일 데이터가 부족합니다." : `${s.net_time_saved_minutes}분/일 (양수는 절감)`}</p><p>저장된 일지(부분 입력 포함) 기준선 ${s.days_logged.baseline}일 · 비서 ${s.days_logged.secretary}일</p><p>승인 경계 위반 ${s.counts.approval_boundary_violations}회 · 취소 위반 ${s.counts.cancellation_violations}회 · 근거 오류 ${s.counts.grounding_errors}회</p><p>놓친 중요 기회 ${s.counts.missed_high_value}회 · 원치 않은 방해 ${s.counts.unwanted_interruptions}회</p><p>${s.missing_data.map(missingLabel).join(" · ")}</p><p>개인 경험 기록이며 인과관계나 다른 사용자에게의 일반화를 증명하지 않습니다.</p>`;
    } catch (error) { output.textContent = errorMessage(error); }
  });
}

export async function historyView(el: HTMLElement, refresh: () => Promise<void>): Promise<void> {
  const { events, total } = await api.history({ limit: 200 });
  el.innerHTML = `<h1>기록 · 백업</h1><p>전체 ${total}건 중 최대 200건 표시. JSON은 열람용이며 복구에는 SQLite 스냅샷을 사용합니다.</p><div class="cluster"><button class="button button-primary" id="export">전체 JSON 내보내기</button><button class="button" id="snapshot">SQLite 스냅샷 생성</button><button class="button button-danger" id="wipe">전체 데이터 삭제</button></div><p id="backup-status" role="status"></p><ul class="list">${events.map(e => `<li class="list-row">${formatDate(e.at)} · ${html(historyLabel(e))}</li>`).join("") || "<li>이력이 없습니다.</li>"}</ul>`;
  el.querySelector("#export")?.addEventListener("click", () => confirmAction("전체 JSON 내보내기", "개인 기록 전체를 이 기기에 다운로드합니다.", async () => downloadJson(await api.exportBackup(), `digithive-${localDate()}.json`), false));
  el.querySelector("#snapshot")?.addEventListener("click", () => confirmAction("스냅샷 생성", "프로젝트 backups 폴더에 독립 SQLite 파일을 만듭니다.", async () => { const { snapshot } = await api.snapshot(); const status = el.querySelector("#backup-status"); if (status) status.textContent = `생성됨: backups/${snapshot.file_name} (${snapshot.size_bytes} bytes)`; }, false));
  el.querySelector("#wipe")?.addEventListener("click", () => openDialog({ title: "전체 데이터 삭제", danger: true, submitLabel: "전체 데이터 삭제", body: `<p>기존 백업 파일은 별도로 남습니다. 현재 데이터베이스의 기록을 지우려면 DELETE_ALL을 입력하세요.</p>${field("confirm", "삭제 확인", { required: true })}`, onSubmit: async f => { if (text(f, "confirm") !== "DELETE_ALL") throw new Error("DELETE_ALL을 정확히 입력하세요."); await api.deleteAll({ confirm: "DELETE_ALL" }); await refresh(); } }));
}
