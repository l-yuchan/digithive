import { api } from "./api-client";
import { html, field, text, openDialog, formatDate, confirmAction } from "./dom";
import { capture } from "./entries";
import { SUGGESTION_STATUS_LABELS } from "./labels";

export async function sourcesView(el: HTMLElement, refresh: () => Promise<void>): Promise<void> {
  const [{ sources }, { entries }, { developments }] = await Promise.all([api.sources(), api.entries(), api.developments()]);
  const sourceForm = (id?: string): void => {
    const s = sources.find(v => v.id === id);
    openDialog({ title: s ? "출처 정정" : "출처 추가", body: `${field("title", "출처 제목", { value: s?.title, required: true })}${field("url", "주소", { value: s?.url, type: "url" })}${field("evidence", "직접 확인한 근거 요약", { value: s?.evidence_summary, required: true, type: "textarea" })}`, onSubmit: async f => {
      const body = { title: text(f, "title"), url: text(f, "url") || null, evidence_summary: text(f, "evidence") };
      if (s) await api.updateSource(s.id, body); else await api.createSource(body);
      await refresh();
    } });
  };
  el.innerHTML = `<h1>자료와 변화</h1><p>자동 수집하지 않습니다. 직접 읽은 근거를 입력하세요.</p><button class="button" id="source-add">출처 추가</button> <button class="button button-primary" id="development-add" ${sources.length ? "" : "disabled"}>새 변화 기록</button><h2>출처</h2><ul class="list">${sources.map(s => `<li class="list-row"><strong>${html(s.title)}</strong><p>${html(s.evidence_summary)}</p><button class="button" data-edit="${s.id}">정정</button> <button class="button button-danger" data-delete="${s.id}">출처 삭제</button></li>`).join("") || "<li>먼저 출처를 추가하세요.</li>"}</ul><h2>새 변화</h2><ul class="list">${developments.map(d => `<li class="list-row">${html(d.summary)} · ${formatDate(d.occurred_at)}<button class="button button-danger" data-dev-delete="${d.id}">삭제</button></li>`).join("")}</ul>`;
  el.querySelector("#source-add")?.addEventListener("click", () => sourceForm());
  el.querySelectorAll<HTMLElement>("[data-edit]").forEach(b => b.addEventListener("click", () => sourceForm(b.dataset.edit)));
  el.querySelectorAll<HTMLElement>("[data-delete]").forEach(b => b.addEventListener("click", () => confirmAction("출처 삭제", "연결된 변화와 제안도 삭제합니다.", async () => { if (b.dataset.delete) await api.deleteSource(b.dataset.delete); await refresh(); })));
  el.querySelectorAll<HTMLElement>("[data-dev-delete]").forEach(b => b.addEventListener("click", () => confirmAction("변화 삭제", "연결된 제안도 삭제합니다.", async () => { if (b.dataset.devDelete) await api.deleteDevelopment(b.dataset.devDelete); await refresh(); })));
  el.querySelector("#development-add")?.addEventListener("click", () => openDialog({
    title: "새 변화 기록",
    body: `<label>출처<select name="source">${sources.map(s => `<option value="${s.id}">${html(s.title)}</option>`).join("")}</select></label>${field("summary", "무엇이 달라졌나", { required: true, type: "textarea" })}<label>장애물을 해결하는 기록 (직접 판단, 선택 사항)<select name="linked"><option value="">직접 연결하지 않음</option>${entries.filter(e => e.status === "active").map(e => `<option value="${e.id}">${html(e.text)}</option>`).join("")}</select></label><label>시급성<select name="urgency"><option value="none">시급하지 않음</option><option value="time_sensitive">기한이 있는 정보</option></select></label>${field("deadline", "기한", { type: "datetime-local" })}`,
    onSubmit: async f => { await api.createDevelopment({ source_id: text(f, "source"), summary: text(f, "summary"), occurred_at: new Date().toISOString(), time_sensitivity: text(f, "urgency") === "time_sensitive" ? "time_sensitive" : "none", deadline: text(f, "deadline") ? new Date(text(f, "deadline")).toISOString() : null, addresses_obstacle_entry_ids: text(f, "linked") ? [text(f, "linked")] : [] }); await refresh(); },
  }));
}

export async function reviewView(el: HTMLElement, refresh: () => Promise<void>): Promise<void> {
  const [{ suggestions }, { preparations }, { triage_events }] = await Promise.all([api.suggestions(), api.preparations(), api.triageEvents()]);
  el.innerHTML = `<h1>제안 검토</h1><p>수락은 실행 승인이 아닙니다. 약한 연결과 보류 항목도 여기에서 확인합니다.</p><ul class="list">${suggestions.map(s => `<li class="list-row" data-suggestion="${s.id}"><span class="badge">${SUGGESTION_STATUS_LABELS[s.status]} · ${s.strength === "strong" ? "강한 연결" : "약한 연결"}</span><p>${html(s.why_now.obstacle_link)}</p><p>${html(s.why_now.evidence_summary)}</p><details><summary>근거와 불확실성</summary><p>${html(s.why_now.explanation)}</p><p>일치어: ${html(s.why_now.matched_terms.join(", "))} · 불확실성: ${html(s.why_now.uncertainty)}</p></details><button class="button" data-act="source">원래 기록과 출처</button>${["queued", "held", "surfaced", "deferred"].includes(s.status) ? '<div class="cluster"><button class="button" data-act="accept">수락만</button><button class="button" data-act="dismiss">다시 제안하지 않기</button><button class="button" data-act="defer">나중에</button><button class="button" data-act="correct">기억 정정</button><button class="button" data-act="explore">로컬 준비 요청</button></div>' : ""}</li>`).join("") || "<li>아직 제안이 없습니다. 관심과 근거 자료를 기록하세요.</li>"}</ul><h2>로컬 준비</h2><ul class="list">${preparations.map(p => `<li class="list-row"><p>${html(p.request)} · ${html(p.status)}</p><p>${html(p.result_summary)}</p><p>${html(p.produced_actions.join(" → "))}</p>${p.status === "pending" ? `<button class="button" data-run="${p.id}">저장 자료로 준비 실행</button> <button class="button" data-stop="${p.id}">실행 전 중단</button>` : ""}</li>`).join("")}</ul><details><summary>조용히 보관하거나 제외한 이유</summary>${triage_events.map(t => `<p>${formatDate(t.at)} · ${html(t.reason)} · ${t.score}</p>`).join("")}</details>`;
  for (const row of el.querySelectorAll<HTMLElement>("[data-suggestion]")) {
    const id = row.dataset.suggestion;
    if (!id) continue;
    row.querySelectorAll<HTMLElement>("[data-act]").forEach(b => b.addEventListener("click", () => {
      const action = b.dataset.act;
      if (action === "source" || action === "correct") {
        void api.suggestion(id).then(v => {
          if (action === "correct") capture(refresh, v.entry);
          else openDialog({ title: "연결된 기록과 출처", body: `<p>${html(v.entry.text)}</p><h3>${html(v.source.title)}</h3><p>${html(v.source.evidence_summary)}</p><p>${html(v.source.url)}</p>` });
        });
      } else if (action === "defer") openDialog({ title: "제안 보류", body: field("until", "다시 볼 시각", { type: "datetime-local", required: true }), onSubmit: async f => { await api.respondSuggestion(id, { action: "defer", defer_until: new Date(text(f, "until")).toISOString() }); await refresh(); } });
      else if (action === "explore") openDialog({ title: "외부 조사 없는 로컬 준비", body: field("request", "준비할 질문", { required: true }), onSubmit: async f => { await api.respondSuggestion(id, { action: "explore", request: text(f, "request"), max_steps: 3 }); await refresh(); } });
      else confirmAction(action === "accept" ? "수락만" : "다시 제안하지 않기", "약속이나 위임으로 자동 전환하지 않습니다.", async () => { await api.respondSuggestion(id, action === "accept" ? { action: "accept" } : { action: "dismiss" }); await refresh(); }, false);
    }));
  }
  el.querySelectorAll<HTMLElement>("[data-run]").forEach(b => b.addEventListener("click", () => confirmAction("로컬 준비 실행", "최대 3단계로 저장 기록만 정리합니다.", async () => { if (b.dataset.run) await api.runPreparation(b.dataset.run); await refresh(); }, false)));
  el.querySelectorAll<HTMLElement>("[data-stop]").forEach(b => b.addEventListener("click", () => confirmAction("준비 중단", "실행하지 않은 작업을 중단합니다.", async () => { if (b.dataset.stop) await api.stopPreparation(b.dataset.stop); await refresh(); })));
}
