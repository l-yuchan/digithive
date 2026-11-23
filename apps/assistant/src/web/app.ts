import { z } from "zod";

const Conversation = z.object({ id: z.string(), title: z.string() });
const Conversations = z.object({ conversations: z.array(Conversation) });
const Message = z.object({
  id: z.string(), role: z.string(), content: z.string(), run_id: z.string().nullable(),
});
const Messages = z.object({ messages: z.array(Message) });
const Enqueued = z.object({ message_id: z.string(), run_id: z.string() });
const RunEvent = z.object({ kind: z.string() });

const STORAGE_KEY = "digithive.conversation";

function element<T extends HTMLElement>(testId: string): T {
  const found = document.querySelector<T>(`[data-testid="${testId}"]`);
  if (!found) throw new Error(`missing element: ${testId}`);
  return found;
}

async function json<T>(schema: z.ZodType<T>, input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return schema.parse(await response.json());
}

function renderMessages(rows: readonly z.infer<typeof Message>[]): void {
  const list = element<HTMLOListElement>("messages");
  list.replaceChildren();
  for (const row of rows) {
    const item = document.createElement("li");
    item.className = `bubble ${row.role}`;
    item.dataset["role"] = row.role;
    const author = document.createElement("span");
    author.className = "author";
    author.textContent = row.role === "user" ? "나" : "비서";
    const body = document.createElement("p");
    body.textContent = row.content;
    item.append(author, body);
    list.append(item);
  }
}

function renderConversations(rows: readonly z.infer<typeof Conversation>[], activeId: string): void {
  const list = element<HTMLUListElement>("conversation-list");
  list.replaceChildren();
  for (const row of rows) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "conversation-item";
    button.textContent = row.title;
    if (row.id === activeId) button.setAttribute("aria-current", "true");
    button.addEventListener("click", () => {
      window.localStorage.setItem(STORAGE_KEY, row.id);
      void load(row.id);
    });
    item.append(button);
    list.append(item);
  }
}

function setStatus(text: string | null, cancelable: boolean): void {
  const status = element<HTMLParagraphElement>("run-status");
  status.hidden = text === null;
  status.textContent = text ?? "";
  element<HTMLButtonElement>("run-cancel").hidden = !cancelable;
}

function showError(message: string | null): void {
  const error = element<HTMLParagraphElement>("chat-error");
  error.hidden = message === null;
  error.textContent = message ?? "";
}

let activeConversation = "";
let activeSource: EventSource | undefined;

const RunStatus = z.object({ status: z.string() });
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

function subscribe(runId: string): void {
  activeSource?.close();
  element<HTMLButtonElement>("run-cancel").hidden = false;
  element<HTMLButtonElement>("run-cancel").onclick = async () => {
    await fetch(`/api/runs/${runId}/cancel`, { method: "POST" });
  };

  const finish = async (status: string) => {
    const labels: Record<string, string> = {
      succeeded: "완료", failed: "실패했습니다. 다시 시도해 주세요.", cancelled: "취소되었습니다.",
      interrupted: "중단되었습니다. 다시 시도해 주세요.",
    };
    setStatus(labels[status] ?? status, false);
    await loadMessages(activeConversation);
  };

  const poll = async () => {
    for (;;) {
      const run = await json(RunStatus, `/api/runs/${runId}`);
      if (TERMINAL.has(run.status)) return finish(run.status);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  };

  const source = new EventSource(`/api/runs/${runId}/events?after=0`);
  activeSource = source;
  const onEvent = () => { source.close(); void poll(); };
  for (const kind of ["succeeded", "failed", "cancelled", "interrupted", "awaiting_approval"]) {
    source.addEventListener(kind, onEvent);
  }
  source.onerror = () => { source.close(); void poll(); };
}

async function loadMessages(conversationId: string): Promise<void> {
  const body = await json(Messages, `/api/conversations/${conversationId}/messages`);
  renderMessages(body.messages);
}

async function refreshRuns(): Promise<void> {
  const runs = z.object({ runs: z.array(z.object({ id: z.string(), status: z.string(), goal: z.string() })) });
  const body = await json(runs, `/api/conversations/${activeConversation}/runs`);
  const latest = body.runs[0];
  if (!latest) return setStatus(null, false);
  const labels: Record<string, string> = {
    queued: "작업 대기 중…", running: "작업 진행 중…", awaiting_approval: "승인을 기다리는 작업이 있습니다.",
    succeeded: "완료", failed: "실패했습니다.", cancelled: "취소되었습니다.", interrupted: "중단되었습니다.",
  };
  const label = labels[latest.status] ?? latest.status;
  setStatus(label, latest.status === "queued" || latest.status === "running" || latest.status === "awaiting_approval");
  if (latest.status === "queued" || latest.status === "running") subscribe(latest.id);
}

async function load(conversationId: string): Promise<void> {
  activeConversation = conversationId;
  element<HTMLElement>("conversation-title").textContent = "대화";
  await loadMessages(conversationId);
  await refreshRuns();
  const body = await json(Conversations, "/api/conversations");
  renderConversations(body.conversations, conversationId);
}

async function currentConversation(): Promise<string> {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  const body = await json(Conversations, "/api/conversations");
  const found = body.conversations.find((row) => row.id === stored) ?? body.conversations[0];
  if (found) return found.id;
  const created = await json(Conversation, "/api/conversations", { method: "POST", body: JSON.stringify({ title: "새 대화" }) });
  return created.id;
}

async function main(): Promise<void> {
  const conversationId = await currentConversation();
  window.localStorage.setItem(STORAGE_KEY, conversationId);
  await load(conversationId);

  element<HTMLFormElement>("composer").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = element<HTMLTextAreaElement>("chat-input");
    const text = input.value.trim();
    if (!text) return;
    showError(null);
    input.value = "";
    try {
      const sent = await json(Enqueued, `/api/conversations/${activeConversation}/messages`, {
        method: "POST",
        body: JSON.stringify({ text, client_request_id: crypto.randomUUID() }),
      });
      await loadMessages(activeConversation);
      setStatus("작업 진행 중…", true);
      subscribe(sent.run_id);
    } catch (error) {
      if (error instanceof Error) showError("메시지를 보내지 못했습니다. 잠시 후 다시 시도해 주세요.");
      throw error;
    }
  });

  element<HTMLButtonElement>("new-conversation").addEventListener("click", async () => {
    const created = await json(Conversation, "/api/conversations", { method: "POST", body: JSON.stringify({ title: "새 대화" }) });
    window.localStorage.setItem(STORAGE_KEY, created.id);
    await load(created.id);
  });

  element<HTMLButtonElement>("logout").addEventListener("click", async () => {
    await fetch("/api/session", { method: "DELETE" });
    location.href = "/";
  });
}

void main();
