import { z } from "zod";

const Connection = z.object({
  id: z.string(), provider: z.string(), scopes: z.array(z.string()), status: z.string(),
  lastSuccessAt: z.string().nullable(),
});
const Connections = z.object({ connections: z.array(Connection) });

const LABELS: Record<string, string> = {
  valid: "연결됨", refreshed: "연결됨 (토큰 갱신)", connected: "연결됨",
  needs_reauth: "다시 인증이 필요합니다", disconnected: "연결 해제됨",
  new: "아직 동기화하지 않았습니다", token_unavailable: "토큰을 확인할 수 없습니다",
};

function element<T extends HTMLElement>(testId: string): T {
  const found = document.querySelector<T>(`[data-testid="${testId}"]`);
  if (!found) throw new Error(`missing element: ${testId}`);
  return found;
}

function render(connections: readonly z.infer<typeof Connection>[]): void {
  const list = element<HTMLUListElement>("connection-list");
  list.replaceChildren();
  for (const connection of connections) {
    const item = document.createElement("li");
    item.className = "file-row";
    item.dataset["provider"] = connection.provider;
    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = connection.provider === "google" ? "Google Calendar·Gmail" : connection.provider;
    const meta = document.createElement("span");
    meta.className = "file-meta";
    meta.textContent = `${LABELS[connection.status] ?? connection.status} · 읽기 권한 ${connection.scopes.length}개`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost";
    remove.dataset["testid"] = "disconnect";
    remove.textContent = "연결 해제";
    remove.addEventListener("click", async () => {
      await fetch(`/api/connections/${connection.id}`, { method: "DELETE" });
      await load();
    });
    item.append(name, meta, remove);
    list.append(item);
  }
}

async function load(): Promise<void> {
  const body = Connections.parse(await (await fetch("/api/connections")).json());
  render(body.connections);
  const status = element<HTMLParagraphElement>("connection-status");
  if (new URLSearchParams(location.search).get("connected") === "google") {
    status.hidden = false;
    status.textContent = "Google 계정을 연결했습니다.";
  }
}

async function main(): Promise<void> {
  await load();
  element<HTMLButtonElement>("logout").addEventListener("click", async () => {
    await fetch("/api/session", { method: "DELETE" });
    location.href = "/";
  });
}

void main();
