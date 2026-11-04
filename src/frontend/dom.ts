import type { ApiError } from "../shared/types";

export function html(value: unknown): string {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char] ?? char);
}
export function formatDate(value: string | null, withTime = true): string {
  if (!value) return "기록 없음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" }).format(date);
}
export function localDate(date = new Date()): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}
export function dateTimeValue(value: string | null): string { return value ? value.slice(0, 16) : ""; }
export function text(form: FormData, key: string): string { return String(form.get(key) ?? "").trim(); }
export function optionalText(form: FormData, key: string): string | null { return text(form, key) || null; }
export function numberValue(form: FormData, key: string): number { return Number(text(form, key) || 0); }
export function nullableNumber(form: FormData, key: string): number | null { const value = text(form, key); return value === "" ? null : Number(value); }
export function isoValue(form: FormData, key: string): string | null { const value = text(form, key); return value ? new Date(value).toISOString() : null; }
export function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "body" in error) {
    const body = (error as { body?: ApiError }).body;
    if (body?.error?.message) return `${body.error.message} (${body.error.code})`;
  }
  return error instanceof Error ? error.message : "요청을 처리하지 못했습니다.";
}
export function emptyState(title: string, guidance: string): string {
  return `<div class="empty"><p><strong>${html(title)}</strong></p><p>${html(guidance)}</p></div>`;
}
export function field(name: string, label: string, options: { value?: unknown; type?: string; required?: boolean; hint?: string; full?: boolean; min?: number; max?: number; step?: number; placeholder?: string } = {}): string {
  const id = `field-${name}-${crypto.randomUUID().slice(0, 8)}`;
  const value = options.value === null || options.value === undefined ? "" : String(options.value);
  const attrs = `${options.required ? "required" : ""} ${options.min !== undefined ? `min="${options.min}"` : ""} ${options.max !== undefined ? `max="${options.max}"` : ""} ${options.step !== undefined ? `step="${options.step}"` : ""}`;
  const hintAttr = options.hint ? ` aria-describedby="${id}-hint"` : "";
  const control = options.type === "textarea" ? `<textarea id="${id}" name="${html(name)}"${hintAttr} ${options.required ? "required" : ""} placeholder="${html(options.placeholder ?? "")}">${html(value)}</textarea>` : `<input id="${id}" name="${html(name)}" type="${html(options.type ?? "text")}"${hintAttr} value="${html(value)}" ${attrs} placeholder="${html(options.placeholder ?? "")}">`;
  return `<div class="field ${options.full ? "field-full" : ""}"><label for="${id}">${html(label)}${options.required ? " <span aria-hidden=\"true\">*</span>" : ""}</label>${control}${options.hint ? `<p class="field-hint" id="${id}-hint">${html(options.hint)}</p>` : ""}</div>`;
}
interface DialogOptions { title: string; body: string; submitLabel?: string; danger?: boolean; onSubmit?: (form: FormData, dialog: HTMLDialogElement) => Promise<void>; }
export function openDialog(options: DialogOptions): HTMLDialogElement {
  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-labelledby", "dialog-title");
  const form = options.onSubmit ? `<form method="dialog" data-dialog-form>${options.body}<div class="dialog-actions"><button class="button" type="button" data-close>취소</button><button class="button ${options.danger ? "button-danger" : "button-primary"}" type="submit">${html(options.submitLabel ?? "저장")}</button></div></form>` : `${options.body}<div class="dialog-actions"><button class="button button-primary" type="button" data-close>닫기</button></div>`;
  dialog.innerHTML = `<div class="dialog-head"><h2 id="dialog-title">${html(options.title)}</h2><button class="button button-quiet icon-button" type="button" data-close aria-label="대화 상자 닫기" title="대화 상자 닫기">×</button></div><div class="dialog-body">${form}</div>`;
  document.body.append(dialog);
  let initialFields = JSON.stringify([...new FormData(dialog.querySelector("form") ?? document.createElement("form"))]);
  queueMicrotask(() => { initialFields = JSON.stringify([...new FormData(dialog.querySelector("form") ?? document.createElement("form"))]); });
  const canDiscard = (): boolean => {
    const currentForm = dialog.querySelector("form");
    return !currentForm || JSON.stringify([...new FormData(currentForm)]) === initialFields || confirm("저장하지 않은 입력을 버리고 닫을까요?");
  };
  dialog.querySelectorAll<HTMLButtonElement>("[data-close]").forEach((button) => button.addEventListener("click", () => { if (canDiscard()) dialog.close(); }));
  dialog.addEventListener("cancel", event => { if (!canDiscard()) event.preventDefault(); });
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  const formElement = dialog.querySelector<HTMLFormElement>("[data-dialog-form]");
  if (formElement && options.onSubmit) formElement.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = formElement.querySelector<HTMLButtonElement>("button[type=submit]");
    formElement.querySelector(".error-box")?.remove();
    if (submit) submit.disabled = true;
    try { await options.onSubmit?.(new FormData(formElement), dialog); dialog.close(); }
    catch (error) {
      formElement.insertAdjacentHTML("afterbegin", `<p class="error-box" role="alert" tabindex="-1">${html(errorMessage(error))}</p>`);
      formElement.querySelector<HTMLElement>(".error-box")?.focus();
      if (submit) submit.disabled = false;
    }
  });
  if (formElement && options.danger) formElement.addEventListener("keydown", event => {
    if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) event.preventDefault();
  });
  dialog.showModal();
  return dialog;
}
export function confirmAction(title: string, message: string, onConfirm: () => Promise<void>, danger = true): void {
  openDialog({ title, body: `<p>${html(message)}</p>`, submitLabel: title, danger, onSubmit: onConfirm });
}
export function downloadJson(value: unknown, fileName: string): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = fileName; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
