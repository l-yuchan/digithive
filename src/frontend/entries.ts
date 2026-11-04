import { api } from "./api-client";
import { field, html, openDialog, text, optionalText, confirmAction, formatDate } from "./dom";
import { KIND_LABELS, STATUS_LABELS } from "./labels";
import type { Entry, EntryContext, EntryKind } from "../shared";

const kinds: readonly EntryKind[] = ["interest", "fact", "hypothesis", "commitment", "delegation"];
function context(kind: EntryKind, f: FormData, previous?: EntryContext): EntryContext {
  switch (kind) {
    case "interest": return { kind, why_it_matters: optionalText(f, "why"), known_obstacle: optionalText(f, "obstacle"), interruption: (["never", "digest_only", "immediate", "when_strong"] as const).find(v => v === text(f, "interruption")) ?? "when_strong" };
    case "fact": return previous?.kind === "fact" ? previous : { kind, decided_at: null };
    case "hypothesis": return { kind, falsifier: optionalText(f, "obstacle") };
    case "commitment": return { ...(previous?.kind === "commitment" ? previous : { scheduled_start: null, scheduled_end: null, reschedule_allowed: false }), kind, due_at: text(f, "due") ? new Date(text(f, "due")).toISOString() : null };
    case "delegation": return { kind, scope: text(f, "scope"), max_steps: previous?.kind === "delegation" ? previous.max_steps : 3, local_only: true };
  }
}
export function capture(refresh: () => Promise<void>, entry?: Entry): void {
  const kindOptions = kinds.map(k => `<option value="${k}" ${entry?.kind === k ? "selected" : ""}>${KIND_LABELS[k]}</option>`).join("");
  const ctx = entry?.context;
  const dialog = openDialog({
    title: entry ? "기록 정정" : "생각 기록",
    body: `<div class="stack"><label>종류<select name="kind" ${entry ? "disabled" : ""}>${kindOptions}</select></label>${field("text", "내용", { type: "textarea", value: entry?.text, required: true })}${field("scope", "적용 범위", { value: entry?.scope ?? "global", required: true, hint: "예: research, writing. 위임은 이 범위의 로컬 기록만 사용합니다." })}${field("why", "왜 중요한가", { value: ctx?.kind === "interest" ? ctx.why_it_matters : "" })}${field("obstacle", "장애물 또는 가설을 바꿀 근거", { value: ctx?.kind === "interest" ? ctx.known_obstacle : ctx?.kind === "hypothesis" ? ctx.falsifier : "" })}${field("due", "약속 기한", { type: "datetime-local", value: ctx?.kind === "commitment" ? ctx.due_at?.slice(0, 16) : "" })}<p>관심은 자동으로 약속이나 위임이 되지 않습니다.</p></div>`,
    onSubmit: async f => {
      const selected = kinds.find(k => k === text(f, "kind")) ?? entry?.kind ?? "interest";
      if (entry) await api.updateEntry(entry.id, { text: text(f, "text"), context: context(selected, f, entry.context), correction_note: "화면에서 정정" });
      else await api.createEntry({ kind: selected, text: text(f, "text"), scope: text(f, "scope"), context: context(selected, f) });
      await refresh();
    },
  });
  const form = dialog.querySelector("form");
  if (form) {
    const label = document.createElement("label");
    label.textContent = "관심 알림 방식";
    const select = document.createElement("select");
    select.name = "interruption";
    for (const [value, title] of [["when_strong", "강한 연결만"], ["never", "알리지 않음"], ["digest_only", "요약 때만"], ["immediate", "즉시"]]) {
      if (!value || !title) continue;
      select.add(new Option(title, value));
    }
    select.value = ctx?.kind === "interest" ? ctx.interruption : "when_strong";
    label.append(select);
    form.querySelector(".dialog-actions")?.before(label);
  }
}
export async function entriesView(el: HTMLElement, refresh: () => Promise<void>): Promise<void> {
  const { entries, total } = await api.entries({ limit: 200 });
  el.innerHTML = `<h1>내 기록</h1><div class="cluster"><button class="button button-primary" id="capture">생각 기록</button><label>기록 검색<input id="search" type="search" placeholder="현재 문장으로 검색"></label></div><p>${total}개 기록 · 최대 200개 표시</p><ul class="list">${entries.map(e => `<li class="list-row" data-entry="${e.id}"><div class="cluster"><span class="badge">${KIND_LABELS[e.kind]}</span><span>${STATUS_LABELS[e.status]}</span><span>${html(e.scope)}</span></div><p>${html(e.text)}</p><small>${formatDate(e.updated_at)}</small><div class="cluster"><button class="button" data-action="detail">이력</button><button class="button" data-action="edit">정정</button>${e.status === "active" ? '<button class="button" data-action="pause">일시정지</button><button class="button" data-action="withdraw">추적 중단</button>' : e.status === "paused" ? '<button class="button" data-action="resume">재개</button>' : ""}${e.kind === "commitment" && e.status === "active" ? '<button class="button" data-action="cancel">일정 취소</button>' : ""}${e.status === "active" ? '<button class="button" data-action="promote">약속·위임 만들기</button>' : ""}<button class="button button-danger" data-action="delete">삭제</button></div></li>`).join("") || "<li>아직 기록이 없습니다. 생각 기록으로 시작하세요.</li>"}</ul>`;
  el.querySelector("#capture")?.addEventListener("click", () => capture(refresh));
  el.querySelector<HTMLInputElement>("#search")?.addEventListener("input", event => {
    if (!(event.target instanceof HTMLInputElement)) return;
    const q = event.target.value.toLocaleLowerCase();
    el.querySelectorAll<HTMLElement>("[data-entry]").forEach(row => { row.hidden = !row.textContent?.toLocaleLowerCase().includes(q); });
  });
  for (const row of el.querySelectorAll<HTMLElement>("[data-entry]")) {
    const e = entries.find(item => item.id === row.dataset.entry);
    if (!e) continue;
    row.querySelectorAll<HTMLButtonElement>("[data-action]").forEach(b => b.addEventListener("click", () => {
      switch (b.dataset.action) {
        case "edit": capture(refresh, e); break;
        case "detail": void api.entry(e.id).then(result => openDialog({ title: "원문과 변경 이력", body: `<p>최초 문장: ${html(e.original_text)}</p>${result.history.map(h => `<p>${formatDate(h.at)} · ${html(h.summary)}</p>`).join("")}` })); break;
        case "promote": openDialog({ title: "명시적으로 약속·위임 만들기", body: `<label>새 종류<select name="to"><option value="commitment">약속</option><option value="delegation">로컬 준비 위임</option></select></label>${field("scope", "위임 범위", { value: e.scope, required: true })}${field("due", "약속 기한", { type: "datetime-local" })}<p>기존 관심은 유지하며 새 기록을 만듭니다. 외부 일정은 변경하지 않습니다.</p>`, onSubmit: async f => { const to = text(f, "to") === "delegation" ? "delegation" : "commitment"; await api.promoteEntry(e.id, { to, scope: text(f, "scope"), due_at: text(f, "due") ? new Date(text(f, "due")).toISOString() : null }); await refresh(); } }); break;
        default: confirmAction(b.textContent ?? "변경", "선택한 기록에 적용합니다.", async () => {
          switch (b.dataset.action) {
            case "pause": await api.pauseEntry(e.id); break;
            case "resume": await api.resumeEntry(e.id); break;
            case "withdraw": await api.withdrawEntry(e.id, { stop_preparation: true }); break;
            case "cancel": await api.cancelSchedule(e.id, { reason: "사용자 취소", reschedule_allowed: false }); break;
            case "delete": await api.deleteEntry(e.id); break;
          }
          await refresh();
        });
      }
    }));
  }
}
