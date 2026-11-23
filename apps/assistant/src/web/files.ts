import { z } from "zod";

const FileRecord = z.object({
  id: z.string(), logicalPath: z.string(), sha256: z.string(), mime: z.string(),
  sizeBytes: z.number(), createdAt: z.string(),
});
const FileList = z.object({ files: z.array(FileRecord) });
const Upload = z.object({ file: FileRecord, extraction: z.string() });

function element<T extends HTMLElement>(testId: string): T {
  const found = document.querySelector<T>(`[data-testid="${testId}"]`);
  if (!found) throw new Error(`missing element: ${testId}`);
  return found;
}

function showError(message: string | null): void {
  const error = element<HTMLParagraphElement>("files-error");
  error.hidden = message === null;
  error.textContent = message ?? "";
}

function render(files: readonly z.infer<typeof FileRecord>[]): void {
  const list = element<HTMLUListElement>("file-list");
  list.replaceChildren();
  for (const file of files) {
    const item = document.createElement("li");
    item.className = "file-row";
    item.dataset["fileId"] = file.id;
    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = file.logicalPath;
    const meta = document.createElement("span");
    meta.className = "file-meta";
    meta.textContent = `${file.mime} · ${Math.ceil(file.sizeBytes / 1024)}KB · ${file.sha256.slice(0, 12)}`;
    const link = document.createElement("a");
    link.className = "ghost link";
    link.href = `/api/files/${file.id}/content`;
    link.textContent = "내려받기";
    item.append(name, meta, link);
    list.append(item);
  }
}

async function load(): Promise<void> {
  const response = await fetch("/api/files");
  const body = FileList.parse(await response.json());
  render(body.files);
}

async function main(): Promise<void> {
  await load();
  element<HTMLFormElement>("upload-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    showError(null);
    const form = new FormData();
    const input = element<HTMLInputElement>("file-upload");
    const selected = input.files?.[0];
    if (!selected) return;
    const path = element<HTMLInputElement>("file-path").value.trim();
    form.set("file", selected);
    if (path) form.set("path", path);
    const response = await fetch("/api/files", { method: "POST", body: form });
    if (!response.ok) {
      const error = z.object({ error: z.string() }).safeParse(await response.json());
      showError(error.success ? `업로드하지 못했습니다: ${error.data.error}` : "업로드하지 못했습니다.");
      return;
    }
    const created = Upload.parse(await response.json());
    const status = element<HTMLParagraphElement>("files-status");
    status.hidden = false;
    status.textContent = created.extraction === "extracted"
      ? `${created.file.logicalPath} 저장: 본문 추출 완료`
      : created.extraction === "unsupported"
        ? `${created.file.logicalPath} 저장: 미리보기를 지원하지 않는 형식`
        : `${created.file.logicalPath} 저장: 본문 추출 실패`;
    input.value = "";
    await load();
  });

  element<HTMLButtonElement>("logout").addEventListener("click", async () => {
    await fetch("/api/session", { method: "DELETE" });
    location.href = "/";
  });
}

void main();
