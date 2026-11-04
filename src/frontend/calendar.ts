import { api } from "./api-client";
import type { CalendarAgenda } from "./api-client";
import { confirmAction, emptyState, errorMessage, field, formatDate, html, openDialog, text } from "./dom";
import { capture } from "./entries";
import { CITATION_LABELS } from "./labels";
import type { CalendarOccurrence, CalendarSubscription } from "../shared";

// Calendar screen. Subscribed feeds are read-only reference data: the app
// shows what is coming, and writing a note about an occurrence is always a
// separate, explicit action by the person.

const RANGES: readonly (readonly [string, string])[] = [
  ["7", "이번 주"],
  ["14", "2주"],
  ["31", "한 달"],
  ["90", "세 달"],
];
const COLORS: readonly (readonly [string, string])[] = [
  ["accent", "청록"],
  ["info", "파랑"],
  ["amber", "호박"],
  ["danger", "빨강"],
  ["neutral", "회색"],
];

let agendaDays = 14;

function dayKey(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

function dayLabel(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("ko-KR", { timeZone, month: "long", day: "numeric", weekday: "short" }).format(new Date(iso));
}

function timeOf(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("ko-KR", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

function timeLabel(event: CalendarOccurrence, timeZone: string): string {
  if (event.all_day) return "종일";
  const start = timeOf(event.starts_at, timeZone);
  if (!event.ends_at) return start;
  const sameDay = dayKey(event.starts_at, timeZone) === dayKey(event.ends_at, timeZone);
  return sameDay ? start + "–" + timeOf(event.ends_at, timeZone) : start + "부터";
}

function calendarOf(calendars: readonly CalendarSubscription[], id: string): CalendarSubscription | undefined {
  return calendars.find(item => item.id === id);
}

function eventLine(event: CalendarOccurrence, calendar: CalendarSubscription | undefined, timeZone: string): string {
  const detail = [calendar?.name ?? "알 수 없는 일정", event.location].filter(Boolean).map(part => html(part)).join(" · ");
  return `<li class="agenda-row">
    <span class="agenda-time">${html(timeLabel(event, timeZone))}</span>
    <span class="agenda-body">
      <span class="agenda-title"><span class="cal-dot" data-color="${html(calendar?.color ?? "neutral")}" aria-hidden="true"></span>${html(event.summary)}</span>
      <span class="small faint">${detail}</span>
    </span>
    <span class="cluster agenda-actions">
      <button class="button button-small" type="button" data-context="${html(event.id)}">맥락</button>
      <button class="button button-small" type="button" data-record="${html(event.id)}">기록</button>
    </span>
  </li>`;
}

function agendaHtml(events: readonly CalendarOccurrence[], calendars: readonly CalendarSubscription[], timeZone: string): string {
  if (events.length === 0) {
    return emptyState("표시할 일정이 없습니다", "구독을 추가하거나 기간을 넓혀 보세요. 일정은 읽기만 하며, 이 화면에서 캘린더를 바꾸지 않습니다.");
  }
  const groups = new Map<string, CalendarOccurrence[]>();
  for (const event of events) {
    const key = dayKey(event.starts_at, timeZone);
    const bucket = groups.get(key) ?? [];
    bucket.push(event);
    groups.set(key, bucket);
  }
  const todayKey = dayKey(new Date().toISOString(), timeZone);
  return Array.from(groups.entries()).map(([key, dayEvents]) => {
    const first = dayEvents[0]!;
    const allDay = dayEvents.filter(event => event.all_day);
    const timed = dayEvents.filter(event => !event.all_day);
    return `<section class="agenda-day">
      <h3>${html(dayLabel(first.starts_at, timeZone))}${key === todayKey ? ' <span class="badge badge-strong">오늘</span>' : ""}</h3>
      <ul class="agenda">${[...allDay, ...timed].map(event => eventLine(event, calendarOf(calendars, event.calendar_id), timeZone)).join("")}</ul>
    </section>`;
  }).join("");
}

function eventWhen(event: CalendarOccurrence, timeZone: string): string {
  return event.all_day
    ? dayLabel(event.starts_at, timeZone) + " 종일"
    : dayLabel(event.starts_at, timeZone) + " " + timeLabel(event, timeZone);
}

function draftFromEvent(event: CalendarOccurrence, calendar: CalendarSubscription | undefined, timeZone: string, refresh: () => Promise<void>): void {
  capture(refresh, undefined, {
    kind: "commitment",
    text: event.summary,
    due_at: event.all_day ? null : event.starts_at,
    note: "일정에서 시작한 초안입니다 · " + eventWhen(event, timeZone) + (calendar ? " · " + calendar.name : "") + ". 저장 전에 문장을 고쳐도 됩니다.",
  });
}

const CONTEXT_STATUS: Record<string, string> = {
  recorded_facts: "확인한 사실이 저장되어 있습니다.",
  includes_inferences: "일부 인용은 추론된 기록입니다. 결정으로 읽지 마세요.",
  insufficient_record: "확정된 결정은 없습니다. 아래 인용은 참고용 기록입니다.",
};

/**
 * Context recovery for one occurrence: what was already written about it,
 * quoted verbatim from the saved records, with the same honesty rules as the
 * query box. Opening this creates nothing.
 */
function openEventContext(event: CalendarOccurrence, calendar: CalendarSubscription | undefined, timeZone: string, refresh: () => Promise<void>): void {
  const dialog = openDialog({ title: "일정의 맥락", body: '<div data-context-body><p class="loading" role="status">저장된 기록을 확인하는 중입니다.</p></div>' });
  const body = dialog.querySelector<HTMLElement>("[data-context-body]");
  if (!body) return;
  void api.calendarEventContext(event.id).then(result => {
    const { query } = result;
    const citations = query.citations.length === 0
      ? emptyState("겹치는 저장 기록이 없습니다", "이 일정 제목과 겹치는 기록이 아직 없습니다. 필요하면 아래에서 기록을 남기세요.")
      : `<ul class="list">${query.citations.map(citation => `<li class="list-row"><div class="cluster"><span class="badge">${html(CITATION_LABELS[citation.entity_type])}</span><small class="faint">${html(formatDate(citation.at, false))}</small></div><blockquote>${html(citation.quote)}</blockquote></li>`).join("")}</ul>`;
    body.innerHTML = `<div class="stack">
      <p class="small muted">${html(eventWhen(event, timeZone))}${calendar ? " · " + html(calendar.name) : ""}</p>
      <p>저장된 기록에서 "${html(result.question)}"과 겹치는 문장을 찾았습니다. 판단은 직접 하고, 인용은 그대로 보여 줍니다.</p>
      ${citations}
      <p class="small faint">${html(query.citations.length === 0
        ? "저장된 기록이 없다는 뜻이며, 앱이 새로 추론한 내용은 없습니다."
        : CONTEXT_STATUS[query.epistemic_status] ?? "")}</p>
    </div>`;
    const actions = dialog.querySelector(".dialog-actions");
    if (actions) {
      actions.insertAdjacentHTML("afterbegin", '<button class="button button-primary" type="button" data-draft>이 일정으로 기록</button>');
      actions.querySelector("[data-draft]")?.addEventListener("click", () => {
        dialog.close();
        draftFromEvent(event, calendar, timeZone, refresh);
      });
    }
  }).catch(error => {
    body.innerHTML = `<p class="error-box" role="alert">${html(errorMessage(error))}</p>`;
  });
}

function wireAgendaActions(root: HTMLElement, events: readonly CalendarOccurrence[], calendars: readonly CalendarSubscription[], timeZone: string, refresh: () => Promise<void>): void {
  root.querySelectorAll<HTMLButtonElement>("[data-record]").forEach(button => {
    button.addEventListener("click", () => {
      const event = events.find(item => item.id === button.dataset["record"]);
      if (!event) return;
      draftFromEvent(event, calendarOf(calendars, event.calendar_id), timeZone, refresh);
    });
  });
  root.querySelectorAll<HTMLButtonElement>("[data-context]").forEach(button => {
    button.addEventListener("click", () => {
      const event = events.find(item => item.id === button.dataset["context"]);
      if (!event) return;
      openEventContext(event, calendarOf(calendars, event.calendar_id), timeZone, refresh);
    });
  });
}

function subscriptionRow(calendar: CalendarSubscription): string {
  const host = (() => { try { return new URL(calendar.url).host; } catch { return calendar.url; } })();
  return `<li class="list-row cal-sub">
    <div class="split">
      <div>
        <p class="cluster"><span class="cal-dot" data-color="${html(calendar.color)}" aria-hidden="true"></span><strong>${html(calendar.name)}</strong>${calendar.enabled ? "" : ' <span class="badge">꺼짐</span>'}</p>
        <p class="small faint mono cal-host">${html(host)}</p>
      </div>
      <div class="cluster">
        <button class="button button-small" type="button" data-sync="${html(calendar.id)}">새로고침</button>
        <button class="button button-small" type="button" data-toggle="${html(calendar.id)}">${calendar.enabled ? "끄기" : "켜기"}</button>
        <button class="button button-small" type="button" data-edit="${html(calendar.id)}">이름·주소</button>
        <button class="button button-small button-danger" type="button" data-remove="${html(calendar.id)}">삭제</button>
      </div>
    </div>
    <p class="small">${calendar.event_count}개 회차 · ${calendar.last_synced_at ? "마지막 동기화 " + html(formatDate(calendar.last_synced_at)) : "아직 동기화하지 않음"}</p>
    ${calendar.last_error ? `<p class="error-box" role="alert">동기화 실패: ${html(calendar.last_error)}</p>` : ""}
  </li>`;
}

function subscriptionDialog(calendar: CalendarSubscription | undefined, refresh: () => Promise<void>): void {
  openDialog({
    title: calendar ? "구독 수정" : "iCal 구독 추가",
    body: `<div class="stack">
      ${field("name", "이름", { value: calendar?.name ?? "", required: true, placeholder: "개인 일정", hint: "여러 캘린더를 구분하는 이름입니다.", help: "이 이름은 화면에만 쓰입니다. 구독 주소의 실제 캘린더 이름과 달라도 됩니다." })}
      ${field("url", "iCal 주소", { value: calendar?.url ?? "", required: true, placeholder: "https://calendar.google.com/calendar/ical/…/basic.ics", hint: "일정 앱의 '비공개 iCal 주소'를 그대로 붙여넣습니다.", help: "구글 캘린더는 설정 → 캘린더 통합 → 비공개 주소의 iCal 형식, 애플 캘린더는 공유 → 공개 캘린더에서 주소를 복사합니다. 주소에는 비밀 토큰이 들어 있어 이 기기에만 저장되며 화면에는 호스트만 표시됩니다." })}
      ${field("color", "색", { type: "select", value: calendar?.color ?? "accent", choices: COLORS, hint: "일정 목록에서 구독을 구분하는 점 색입니다.", help: "색은 구분을 돕기 위한 표시입니다. 이름이 항상 함께 표시되므로 색만으로 구분하지 않아도 됩니다." })}
      <p class="small faint">일정은 읽기만 합니다. 앱이 캘린더에 쓰거나 초대를 보내지 않습니다.</p>
    </div>`,
    onSubmit: async form => {
      const body = { name: text(form, "name"), url: text(form, "url"), color: text(form, "color") as CalendarSubscription["color"] };
      if (calendar) await api.updateCalendar(calendar.id, body);
      else await api.createCalendar(body);
      await refresh();
    },
  });
}

export async function calendarView(el: HTMLElement, refresh: () => Promise<void>): Promise<void> {
  const [list, agenda] = await Promise.all([api.calendars(), api.calendarAgenda({ days: agendaDays })]);
  const { calendars, total } = list;
  el.innerHTML = `<h1>일정</h1>
    <p class="muted">구독한 iCal 캘린더를 이 기기에서만 읽습니다. 일정은 참고용이고, 기록은 직접 남깁니다.</p>
    <div class="cluster cal-controls">
      <label>기간<select data-range>${RANGES.map(([value, label]) => `<option value="${value}" ${String(agendaDays) === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
      <button class="button" type="button" data-sync-all>모두 새로고침</button>
      <button class="button button-primary" type="button" data-add>구독 추가</button>
    </div>
    <section aria-labelledby="agenda-title">
      <div class="section-title"><h2 id="agenda-title">앞으로의 일정</h2><span class="small faint">${agenda.events.length}개 · ${html(agenda.timezone)}</span></div>
      <div data-agenda>${agendaHtml(agenda.events, agenda.calendars, agenda.timezone)}</div>
    </section>
    <section aria-labelledby="subs-title">
      <div class="section-title"><h2 id="subs-title">구독</h2><span class="small faint">${total}개</span></div>
      ${calendars.length === 0
        ? emptyState("아직 구독한 캘린더가 없습니다", "구글·애플 캘린더의 비공개 iCal 주소를 추가하면 이 화면에 일정이 나타납니다.")
        : `<ul class="list">${calendars.map(subscriptionRow).join("")}</ul>`}
    </section>`;

  wireAgendaActions(el, agenda.events, agenda.calendars, agenda.timezone, refresh);

  el.querySelector("[data-add]")?.addEventListener("click", () => subscriptionDialog(undefined, refresh));
  el.querySelector<HTMLSelectElement>("[data-range]")?.addEventListener("change", event => {
    const select = event.currentTarget;
    if (!(select instanceof HTMLSelectElement)) return;
    agendaDays = Number(select.value);
    void refresh();
  });
  el.querySelector("[data-sync-all]")?.addEventListener("click", async () => {
    await api.syncAllCalendars().catch(() => undefined);
    await refresh();
  });
  for (const button of el.querySelectorAll<HTMLButtonElement>("[data-sync]")) {
    button.addEventListener("click", async () => {
      const id = button.dataset["sync"];
      if (!id) return;
      button.disabled = true;
      await api.syncCalendar(id).catch(() => undefined);
      await refresh();
    });
  }
  for (const button of el.querySelectorAll<HTMLButtonElement>("[data-toggle]")) {
    button.addEventListener("click", () => {
      const calendar = calendars.find(item => item.id === button.dataset["toggle"]);
      if (!calendar) return;
      void api.updateCalendar(calendar.id, { enabled: !calendar.enabled }).then(() => refresh());
    });
  }
  for (const button of el.querySelectorAll<HTMLButtonElement>("[data-edit]")) {
    button.addEventListener("click", () => {
      const calendar = calendars.find(item => item.id === button.dataset["edit"]);
      if (calendar) subscriptionDialog(calendar, refresh);
    });
  }
  for (const button of el.querySelectorAll<HTMLButtonElement>("[data-remove]")) {
    button.addEventListener("click", () => {
      const calendar = calendars.find(item => item.id === button.dataset["remove"]);
      if (!calendar) return;
      confirmAction("구독 삭제", `"${calendar.name}" 구독과 저장된 ${calendar.event_count}개 회차를 지웁니다. 캘린더 원본은 바뀌지 않습니다.`, async () => {
        await api.deleteCalendar(calendar.id);
        await refresh();
      });
    });
  }
}

/** Compact agenda for the today screen: today plus the rest of the week. */
export async function todayAgenda(el: HTMLElement, refresh: () => Promise<void>): Promise<void> {
  const agenda: CalendarAgenda = await api.calendarAgenda({ days: 7 });
  const shown = agenda.events.slice(0, 8);
  el.innerHTML = `<div class="section-title"><h2>이번 주 일정</h2><a class="small" href="#calendar">일정 화면 열기</a></div>
    ${agenda.events.length === 0
      ? emptyState("구독한 일정이 없습니다", "일정 화면에서 iCal 주소를 추가하면 이 주의 일정이 여기에 나타납니다.")
      : `<div class="stack">${agendaHtml(shown, agenda.calendars, agenda.timezone)}</div>${agenda.events.length > shown.length ? `<p class="small faint">${agenda.events.length - shown.length}개 더 있습니다.</p>` : ""}`}`;
  wireAgendaActions(el, shown, agenda.calendars, agenda.timezone, refresh);
}
