import { api } from "./api-client";
import { field, html, openDialog, text, optionalText, confirmAction, formatDate, dateTimeValue } from "./dom";
import { KIND_HELP, KIND_LABELS, STATUS_LABELS } from "./labels";
import type { Entry, EntryContext, EntryKind, InterestContext } from "../shared";

const kinds: readonly EntryKind[] = ["interest", "fact", "hypothesis", "commitment", "delegation"];
const interruptionChoices: readonly (readonly [string, string])[] = [
  ["never", "알리지 않음"],
  ["digest_only", "요약 때만"],
  ["when_strong", "강한 연결만"],
  ["immediate", "즉시"],
];

/** Prefilled draft, used when a note is started from a calendar occurrence. */
export interface CapturePreset {
  kind?: EntryKind;
  text?: string;
  scope?: string;
  due_at?: string | null;
  note?: string;
}

function context(kind: EntryKind, f: FormData, previous?: EntryContext): EntryContext {
  switch (kind) {
    case "interest":
      return {
        kind,
        why_it_matters: optionalText(f, "why"),
        known_obstacle: optionalText(f, "interest_obstacle"),
        interruption: (interruptionChoices.find(([value]) => value === text(f, "interruption"))?.[0] ?? "when_strong") as InterestContext["interruption"],
      };
    case "fact": return previous?.kind === "fact" ? previous : { kind, decided_at: null };
    case "hypothesis": return { kind, falsifier: optionalText(f, "hypothesis_falsifier") };
    case "commitment":
      return {
        ...(previous?.kind === "commitment" ? previous : { scheduled_start: null, scheduled_end: null, reschedule_allowed: false }),
        kind,
        due_at: text(f, "due") ? new Date(text(f, "due")).toISOString() : null,
      };
    case "delegation":
      return { kind, scope: text(f, "scope"), max_steps: previous?.kind === "delegation" ? previous.max_steps : 3, local_only: true };
  }
}

function helpDisclosure(label: string, explanation: string): string {
  return `<details class="field-help"><summary title="${html(explanation)}" aria-label="${html(label)} 설명 보기">?</summary><p>${html(explanation)}</p></details>`;
}

export function capture(refresh: () => Promise<void>, entry?: Entry, preset: CapturePreset = {}): void {
  const ctx = entry?.context;
  const initialKind = entry?.kind ?? preset.kind ?? "interest";
  const dueValue = entry
    ? ctx?.kind === "commitment" ? dateTimeValue(ctx.due_at) : ""
    : dateTimeValue(preset.due_at ?? null);
  const dialog = openDialog({
    title: entry ? "기록 정정" : "생각 기록",
    body: `<div class="stack">
      ${preset.note ? `<p class="notice">${html(preset.note)}</p>` : ""}
      <div class="field field-full">
        <div class="field-label-row"><span class="field-label" id="capture-kind-label">어떤 기록인가요?</span>${helpDisclosure("기록 종류", "종류가 검색·제안·알림 방식을 정합니다. 종류는 직접 고르는 값이며, 관심이 저절로 약속이나 위임이 되지는 않습니다. 각 이름 위에 마우스를 올리면 설명이 보입니다.")}</div>
        <div class="kind-picker" role="radiogroup" aria-labelledby="capture-kind-label">
          ${kinds.map(kind => `<label class="kind-option"><input type="radio" name="kind" value="${kind}" ${kind === initialKind ? "checked" : ""} ${entry ? "disabled" : ""}><span title="${html(KIND_HELP[kind])}">${KIND_LABELS[kind]}</span></label>`).join("")}
        </div>
        <p class="field-hint" id="kind-explain" aria-live="polite">${html(KIND_HELP[initialKind])}</p>
      </div>
      ${field("text", "무엇을 남길까요?", { type: "textarea", value: entry?.text ?? preset.text, required: true, hint: "나중에 이 문장으로 검색합니다.", help: "적어 둔 문장이 그대로 보존됩니다. 나중에 고쳐도 최초 문장은 이력에 남으므로, 기억이 틀렸다고 판단되면 지우지 말고 정정하세요." })}
      ${field("scope", "어디에 적용되나요?", { value: entry?.scope ?? preset.scope ?? "global", required: true, hint: "예: research, writing", help: "검색과 제안이 참고할 범위 이름입니다. 같은 낱말이라도 범위가 다르면 다른 맥락으로 다룹니다. 잘 모르겠으면 그대로 두세요." })}
      <div class="stack" data-kind-field="interest">
        ${field("why", "왜 중요한가요?", { value: ctx?.kind === "interest" ? ctx.why_it_matters : "", hint: "나중에 이 관심을 다시 꺼낼 이유입니다.", help: "이유를 적어 두면, 같은 이유와 겹치는 자료가 들어왔을 때 그 자료를 먼저 보여 줍니다. 비워 두면 낱말이 겹칠 때만 제안합니다." })}
        ${field("interest_obstacle", "지금 무엇이 막고 있나요?", { value: ctx?.kind === "interest" ? ctx.known_obstacle : "", hint: "해결의 실마리가 되는 자료를 기다리는 중이라면 그 내용을 적습니다.", help: "막고 있는 것을 적어 두면, 그 장애물을 다루는 자료가 들어왔을 때 이것을 연결해 줍니다. 막는 것이 없으면 비워 두세요." })}
        ${field("interruption", "이 관심의 알림 시점", { type: "select", value: ctx?.kind === "interest" ? ctx.interruption : "when_strong", choices: interruptionChoices, hint: "지금은 '강한 연결만'이 기본입니다.", help: "이 관심에 대한 제안을 언제 보여 줄지 정합니다. '알리지 않음'은 기록만 남기고 제안하지 않습니다. '요약 때만'은 정기 요약에 모아 보여 줍니다." })}
      </div>
      <div class="stack" data-kind-field="hypothesis">
        ${field("hypothesis_falsifier", "무엇이 확인되면 틀렸다고 볼까요?", { value: ctx?.kind === "hypothesis" ? ctx.falsifier : "", hint: "반증 조건을 적어 두면 판단이 흔들리지 않습니다.", help: "이 가설을 버릴 근거를 미리 적어 둡니다. 나중에 근거가 나와도 앱이 스스로 결론을 내리지 않고, 이 문장과 비교할 수 있게 남겨 둡니다." })}
      </div>
      <div class="stack" data-kind-field="commitment">
        ${field("due", "기한이 있나요?", { type: "datetime-local", value: dueValue, hint: "비워 두면 기한 없는 약속입니다.", help: "기한은 알림과 검토에 쓰입니다. 기한이 지나도 자동으로 완료 처리하지 않으며, 취소하거나 미루는 것은 직접 정합니다." })}
      </div>
      <p class="field-hint" data-kind-field="fact">확인한 사실은 출처와 함께 남길 때 가장 쓸모가 있습니다. 자료와 변화 화면에서 출처를 먼저 기록할 수 있습니다.</p>
      <p class="field-hint" data-kind-field="delegation">위임은 위의 적용 범위 안에 있는 이 기기의 기록만 읽습니다.</p>
      <p>관심은 자동으로 약속이나 위임이 되지 않습니다.</p>
    </div>`,
    onSubmit: async f => {
      const selected = (Array.from(dialog.querySelectorAll<HTMLInputElement>("input[name=kind]")).find(input => input.checked)?.value ?? entry?.kind ?? "interest") as EntryKind;
      if (entry) await api.updateEntry(entry.id, { text: text(f, "text"), context: context(selected, f, entry.context), correction_note: "화면에서 정정" });
      else await api.createEntry({ kind: selected, text: text(f, "text"), scope: text(f, "scope"), context: context(selected, f) });
      await refresh();
    },
  });

  const form = dialog.querySelector("form");
  const syncKind = (): void => {
    const kind = (Array.from(dialog.querySelectorAll<HTMLInputElement>("input[name=kind]")).find(input => input.checked)?.value ?? initialKind) as EntryKind;
    for (const node of dialog.querySelectorAll<HTMLElement>("[data-kind-field]")) {
      const visible = node.dataset["kindField"] === kind;
      node.hidden = !visible;
      // Hidden fields must not submit stale values for the other kinds.
      for (const control of node.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea")) {
        control.disabled = !visible;
      }
    }
    const explain = dialog.querySelector<HTMLElement>("#kind-explain");
    if (explain) explain.textContent = KIND_HELP[kind];
  };
  form?.addEventListener("change", syncKind);
  syncKind();
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
