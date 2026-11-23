import { z } from "zod";

const Memory = z.object({
  id: z.string(), statement: z.string(), kind: z.string(), status: z.string(),
  evidence_ref: z.string(), revision: z.number(), context_epoch: z.number(),
});
const List = z.object({ memories: z.array(Memory) });

function element<T extends HTMLElement>(testId: string): T {
  const found = document.querySelector<T>(`[data-testid="${testId}"]`);
  if (!found) throw new Error(`missing element: ${testId}`);
  return found;
}

function setError(message: string | null): void {
  const error = element<HTMLParagraphElement>("memory-error");
  error.hidden = message === null;
  error.textContent = message ?? "";
}

function setStatus(message: string | null): void {
  const status = element<HTMLParagraphElement>("memory-status");
  status.hidden = message === null;
  status.textContent = message ?? "";
}

async function render(): Promise<void> {
  const body = List.parse(await (await fetch("/api/memories")).json());
  const list = element<HTMLUListElement>("memory-list");
  list.replaceChildren();
  for (const memory of body.memories) {
    const item = document.createElement("li");
    item.className = "file-row";
    item.dataset["memoryId"] = memory.id;
    item.dataset["revision"] = String(memory.revision);

    const text = document.createElement("span");
    text.className = "file-name";
    text.textContent = memory.statement;
    const meta = document.createElement("span");
    meta.className = "file-meta";
    meta.textContent = `${memory.kind} · rev ${memory.revision} · ${memory.evidence_ref}`;

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "ghost";
    edit.dataset["testid"] = "memory-edit";
    edit.textContent = "수정";
    edit.addEventListener("click", () => {
      const input = document.createElement("input");
      input.type = "text";
      input.value = memory.statement;
      input.dataset["testid"] = "memory-correction";
      input.className = "inline-edit";
      const apply = document.createElement("button");
      apply.type = "button";
      apply.className = "primary";
      apply.dataset["testid"] = "memory-apply";
      apply.textContent = "저장";
      apply.addEventListener("click", () => void save(memory.id, memory.revision, input.value));
      item.replaceChildren(text, input, apply);
      input.focus();
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost";
    remove.dataset["testid"] = "memory-delete";
    remove.textContent = "삭제";
    remove.addEventListener("click", () => void removeMemory(memory.id, memory.revision));

    item.append(text, meta, edit, remove);
    list.append(item);
  }
}

async function save(id: string, revision: number, correction: string): Promise<void> {
  setError(null);
  const response = await fetch(`/api/memories/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision, correction }),
  });
  if (response.status === 409) {
    setError("다른 곳에서 먼저 수정되었습니다. 새로 고친 뒤 다시 시도해 주세요.");
    await render();
    return;
  }
  if (!response.ok) {
    setError("기억을 수정하지 못했습니다.");
    return;
  }
  setStatus("수정했습니다. 이후 답변과 브리핑은 새 내용을 사용합니다.");
  await render();
}

async function removeMemory(id: string, revision: number): Promise<void> {
  const response = await fetch(`/api/memories/${id}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision }),
  });
  if (!response.ok) {
    setError(response.status === 409 ? "이미 바뀐 기억입니다. 새로 고쳐 주세요." : "기억을 삭제하지 못했습니다.");
    return;
  }
  setStatus("삭제했습니다. 활성 검색에서 제외됩니다.");
  await render();
}

async function main(): Promise<void> {
  await render();
  element<HTMLFormElement>("memory-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    setError(null);
    const statement = element<HTMLInputElement>("memory-statement").value.trim();
    const kind = element<HTMLSelectElement>("memory-kind").value;
    const evidence = element<HTMLInputElement>("memory-evidence").value.trim();
    if (!statement || !evidence) return;
    const response = await fetch("/api/memories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ statement, kind, evidence_ref: evidence }),
    });
    if (!response.ok) {
      setError("기억을 저장하지 못했습니다.");
      return;
    }
    setStatus("기억을 저장했습니다.");
    element<HTMLInputElement>("memory-statement").value = "";
    await render();
  });

  element<HTMLButtonElement>("logout").addEventListener("click", async () => {
    await fetch("/api/session", { method: "DELETE" });
    location.href = "/";
  });
}

export { Memory };
void main();
