import { html, localDate } from "./dom";
import { OFFLINE_NOTICE, ROUTE_LABELS } from "./labels";
import type { Route } from "./ui-types";
import { api } from "./api-client";
import { entriesView, capture } from "./entries";
import { sourcesView, reviewView } from "./review";
import { errorMessage, field, text } from "./dom";
import { journalView, historyView } from "./journal";
import { settingsView } from "./settings";
import { calendarView, todayAgenda } from "./calendar";

const routes = Object.keys(ROUTE_LABELS) as Route[];
let route: Route = routes.find(item => item === location.hash.slice(1)) ?? "today";
let authed = false;
let authEnabled = false;
const storedTheme = localStorage.getItem("digithive-theme") ?? "system";
function applyTheme(theme: string): void {
  document.documentElement.dataset.theme = theme === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : theme;
}
applyTheme(storedTheme);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if ((localStorage.getItem("digithive-theme") ?? "system") === "system") applyTheme("system");
});

function shell(): string {
  return `<div class="app-shell">
    <aside class="sidebar" aria-label="주 메뉴">
      <a class="brand" href="#today" aria-label="디지트하이브 오늘 화면"><span class="brand-mark" aria-hidden="true">ㄷ</span><span class="brand-name">디지트하이브</span></a>
      <nav class="main-nav">${routes.map((item) => `<a class="nav-link" href="#${item}" ${item === route ? 'aria-current="page"' : ""}>${ROUTE_LABELS[item]}</a>`).join("")}</nav>
      <div class="sidebar-foot"><span class="mode-badge">오프라인 규칙 모드</span><label class="small">테마<select data-theme-toggle><option value="system">시스템</option><option value="light">밝게</option><option value="dark">어둡게</option></select></label>${authEnabled ? '<button class="button button-small" type="button" data-logout>로그아웃</button>' : ''}</div>
    </aside>
    <div class="workspace"><header class="topbar"><span class="small muted">한 사람의 한 달 · ${localDate()}</span><span class="small">저장과 판단은 이 기기 안에서</span></header><main class="main-content" id="main-content" tabindex="-1"></main></div>
  </div>`;
}
function render(): void {
  document.querySelector("#app")!.innerHTML = shell();
  const main = document.querySelector<HTMLElement>("#main-content")!;
  main.innerHTML = `<div class="page-head"><div><h1>오늘</h1><p>생각을 기록하고 저장된 근거에서 맥락을 복원합니다.</p></div></div><details class="notice offline-details"><summary>AI 모델 없이 작동합니다 · 정확한 한계 보기</summary><p>${html(OFFLINE_NOTICE)}</p></details>`;
  if (route !== "today") main.querySelector(".page-head")?.remove();
  const content = document.createElement("section");
  content.className = "stack-lg";
  main.append(content);
  const refresh = async (): Promise<void> => {
    content.innerHTML = "<p role='status'>기록을 불러오는 중입니다.</p>";
    try {
      switch (route) {
        case "calendar": await calendarView(content, refresh); break;
        case "entries": await entriesView(content, refresh); break;
        case "sources": await sourcesView(content, refresh); break;
        case "review": await reviewView(content, refresh); break;
        case "today":
          content.innerHTML = `<section class="stack" id="today-agenda" aria-label="이번 주 일정"></section><h2>맥락 복원</h2><button class="button button-primary" id="today-capture">생각 기록</button><form id="query" class="stack">${field("question", "저장된 기록에 질문하기", { required: true, placeholder: "기억 오염에 대해 무엇을 남겼지?" })}<button class="button">기록에서 찾기</button></form><div id="answer" aria-live="polite"></div>`;
          const agendaSlot = content.querySelector<HTMLElement>("#today-agenda");
          if (agendaSlot) await todayAgenda(agendaSlot, refresh).catch(() => {
            agendaSlot.innerHTML = '<p class="error-box" role="alert">일정을 불러오지 못했습니다. 일정 화면에서 구독 상태를 확인하세요.</p>';
          });
          content.querySelector("#today-capture")?.addEventListener("click", () => capture(refresh));
          content.querySelector<HTMLFormElement>("#query")?.addEventListener("submit", async event => {
            event.preventDefault();
            if (!(event.currentTarget instanceof HTMLFormElement)) return;
            const answer = content.querySelector("#answer");
            if (!answer) return;
            answer.textContent = "저장 기록을 확인합니다.";
            try {
              const result = await api.retrieval({ question: text(new FormData(event.currentTarget), "question") });
              answer.innerHTML = `<p>${html(result.answer)}</p><p>${result.epistemic_status === "insufficient_record" ? "확정할 기록이 부족합니다." : "아래 기록을 근거로 복원했습니다."}</p>${result.citations.map(c => `<blockquote>${html(c.quote)}</blockquote>`).join("")}`;
            } catch (error) { answer.textContent = errorMessage(error); }
          });
          break;
        case "evaluation": await journalView(content); break;
        case "history": await historyView(content, refresh); break;
        case "settings": await settingsView(content, refresh); break;
      }
    } catch (error) {
      content.innerHTML = `<p class="error-box" role="alert">${html(errorMessage(error))}</p><button class="button" id="retry">다시 연결</button>`;
      content.querySelector("#retry")?.addEventListener("click", () => { void refresh(); });
    }
  };
  void refresh();
  const themeControl = document.querySelector<HTMLSelectElement>("[data-theme-toggle]");
  if (themeControl) {
    themeControl.value = localStorage.getItem("digithive-theme") ?? "system";
    themeControl.addEventListener("change", () => { applyTheme(themeControl.value); localStorage.setItem("digithive-theme", themeControl.value); });
  }
  document.querySelector("[data-logout]")?.addEventListener("click", () => {
    authed = false;
    renderLogin();
    api.logout().catch(() => { /* no-excuse-ok: catch */ });
  });
}
function renderLogin(): void {
  document.querySelector("#app")!.innerHTML = `<main class="boot-screen login-screen" id="main-content"><div class="login-card"><h1>디지트하이브</h1><p>이 기록은 비밀번호로 보호되어 있습니다.</p><form id="login-form" class="stack">${field("passphrase", "비밀번호", { type: "password", required: true })}<button class="button button-primary" type="submit">로그인</button></form><p id="login-error" role="alert" aria-live="polite"></p></div></main>`;
  const form = document.querySelector<HTMLFormElement>("#login-form");
  const error = document.querySelector<HTMLElement>("#login-error");
  if (!form || !error) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    const value = new FormData(form).get("passphrase");
    try {
      await api.login(String(value ?? ""));
      authed = true;
      render();
    } catch (e) {
      error.textContent = errorMessage(e);
    }
  });
}

async function boot(): Promise<void> {
  try {
    const status = await api.authStatus();
    authEnabled = status.enabled;
    if (status.enabled && !status.authenticated) { renderLogin(); return; }
    authed = true;
    render();
  } catch {
    renderLogin();
    const error = document.querySelector<HTMLElement>("#login-error");
    if (error) error.textContent = "서버에 연결할 수 없습니다.";
  }
}

addEventListener("hashchange", () => {
  if (!authed) return;
  const next = location.hash.slice(1);
  if (next === "main-content") { (document.querySelector("#main-content") as HTMLElement | null)?.focus(); return; }
  route = routes.includes(next as Route) ? (next as Route) : "today";
  render();
});
void boot();
