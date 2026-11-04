import { api } from "./api-client";
import { field, html, text, openDialog, confirmAction } from "./dom";
import type { PreferenceKey } from "../shared";
const choices: Record<PreferenceKey, readonly [string, string][]> = {
  interruption: [["never", "알리지 않음"], ["digest_only", "요약 때만"], ["when_strong", "강한 연결만"], ["immediate", "즉시"]],
  delivery: [["digest", "정기 요약"], ["immediate", "즉시"]],
  proactivity: [["off", "중지"], ["suggestions_only", "제안만"], ["suggestions_and_preparation", "제안과 로컬 준비"]],
  report_style: [["concise_first", "간단한 요약 먼저"], ["detailed", "자세히"], ["summary_only", "요약만"]],
};
export async function settingsView(el: HTMLElement, refresh: () => Promise<void>): Promise<void> {
  const [{ settings }, { preferences }] = await Promise.all([api.settings(), api.preferences()]);
  el.innerHTML = `<h1>설정</h1><form id="settings" class="stack"><label class="check"><input name="quiet" type="checkbox" ${settings.quiet_mode ? "checked" : ""}>조용 모드 · 모든 즉시 제안 보류</label><label>전달 방식<select name="delivery"><option value="immediate" ${settings.delivery === "immediate" ? "selected" : ""}>즉시</option><option value="digest" ${settings.delivery === "digest" ? "selected" : ""}>정기 요약</option></select></label>${field("digest", "정기 요약 시각", { type: "time", value: settings.digest_time, required: true })}${field("timezone", "시간대 (IANA)", { value: settings.timezone, required: true })}<button class="button button-primary">설정 저장</button></form><h2>집중 시간</h2><p>기한이 없는 제안을 보류합니다. 조용 모드는 시급한 제안도 보류합니다.</p><ul class="list">${settings.focus_windows.map(w => `<li>${html(w.label)} · ${w.start}~${w.end} · 요일 ${w.days.join(", ")} <button class="button" data-focus-delete="${w.id}">집중 시간 삭제</button></li>`).join("")}</ul><button class="button" id="focus-add">집중 시간 추가</button><h2>범위별 선호</h2><p>기록의 적용 범위와 동일한 이름을 사용하세요. global은 공통 기본값입니다.</p><div id="preference-buttons" class="cluster">${Object.keys(choices).map(key => `<button class="button" data-key="${key}">${({ interruption: "알림", delivery: "전달", proactivity: "능동성", report_style: "설명 방식" })[key as PreferenceKey]} 선호 추가</button>`).join("")}</div><ul class="list">${preferences.map(p => `<li class="list-row">${html(p.scope)} · ${html(choices[p.key].find(v => v[0] === p.value)?.[1] ?? p.value)} · ${p.status === "active" ? "적용" : "철회"} <button class="button" data-pref-edit="${p.id}">정정</button><button class="button" data-pref-withdraw="${p.id}">철회</button></li>`).join("")}</ul>`;
  el.querySelector<HTMLFormElement>("#settings")?.addEventListener("submit", event => {
    event.preventDefault();
    if (!(event.currentTarget instanceof HTMLFormElement)) return;
    const f = new FormData(event.currentTarget);
    confirmAction("설정 저장", "현재 전달 설정을 변경합니다.", async () => { await api.updateSettings({ quiet_mode: f.has("quiet"), quiet_until: null, delivery: text(f, "delivery") === "digest" ? "digest" : "immediate", digest_time: text(f, "digest"), timezone: text(f, "timezone") }); await refresh(); }, false);
  });
  el.querySelector("#focus-add")?.addEventListener("click", () => openDialog({ title: "집중 시간 추가", body: `${field("label", "이름", { required: true })}${field("start", "시작", { type: "time", required: true })}${field("end", "종료", { type: "time", required: true })}${field("days", "요일 (0=일요일, 쉼표 구분)", { value: "1,2,3,4,5", required: true })}`, onSubmit: async f => { await api.updateSettings({ focus_windows: [...settings.focus_windows, { id: crypto.randomUUID(), label: text(f, "label"), start: text(f, "start"), end: text(f, "end"), days: text(f, "days").split(",").map(Number) }] }); await refresh(); } }));
  el.querySelectorAll<HTMLElement>("[data-focus-delete]").forEach(b => b.addEventListener("click", () => confirmAction("집중 시간 삭제", "이 시간대의 보류 규칙을 제거합니다.", async () => { await api.updateSettings({ focus_windows: settings.focus_windows.filter(w => w.id !== b.dataset.focusDelete) }); await refresh(); })));
  function preferenceDialog(key: PreferenceKey, id?: string): void {
    const current = preferences.find(p => p.id === id);
    openDialog({ title: "범위별 선호", body: `${field("scope", "적용 범위", { value: current?.scope ?? "global", required: true })}<label>선호 값<select name="value">${choices[key].map(([value, label]) => `<option value="${value}" ${current?.value === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>`, onSubmit: async f => { const body = { key, scope: text(f, "scope"), value: text(f, "value") }; if (id) await api.updatePreference(id, body); else await api.createPreference(body); await refresh(); } });
  }
  el.querySelectorAll<HTMLElement>("[data-key]").forEach(b => b.addEventListener("click", () => { const key = b.dataset.key; if (key === "interruption" || key === "delivery" || key === "proactivity" || key === "report_style") preferenceDialog(key); }));
  el.querySelectorAll<HTMLElement>("[data-pref-edit]").forEach(b => b.addEventListener("click", () => { const p = preferences.find(v => v.id === b.dataset.prefEdit); if (p) preferenceDialog(p.key, p.id); }));
  el.querySelectorAll<HTMLElement>("[data-pref-withdraw]").forEach(b => b.addEventListener("click", () => confirmAction("선호 철회", "다른 범위의 선호는 유지합니다.", async () => { if (b.dataset.prefWithdraw) await api.updatePreference(b.dataset.prefWithdraw, { status: "withdrawn" }); await refresh(); })));
}
