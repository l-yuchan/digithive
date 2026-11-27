import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import { saveItems } from "../../src/integrations/sync-store";
import { WhiteboardFrontmatterSchema } from "../../src/whiteboard/schema";
import {
  evidenceArgument,
  responseBody,
  runBrowserCapture,
  saveEvidence,
  startQaHarness,
} from "./harness-fixture";

const DocumentResponse = z.object({
  document: z.object({
    id: z.string(),
    path: z.string(),
    kind: z.enum(["record", "thread", "commitment", "watch"]),
    title: z.string(),
    text: z.string(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.string(),
  }),
});
const DocumentList = z.object({
  documents: z.array(
    z.object({
      id: z.string(),
      path: z.string(),
      kind: z.enum(["record", "thread", "commitment", "watch"]),
      title: z.string(),
      status: z.string(),
      hash: z.string(),
      source: z.record(z.string(), z.unknown()),
    }),
  ),
});

function filesBelow(root: string, directory = root): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesBelow(root, path) : [relative(root, path)];
  });
}

async function documentPost(
  app: Awaited<ReturnType<typeof startQaHarness>>,
  token: string,
  body: unknown,
) {
  const response = await app.request("/api/whiteboard", { token, method: "POST", body });
  return { status: response.status, body: await responseBody(response) };
}

const evidenceDir = evidenceArgument();
const app = await startQaHarness({ name: "whiteboard", modelBaseUrl: "http://127.0.0.1:1/v1" });
const receipts: unknown[] = [];
try {
  const token = await app.login();
  const now = Date.now();
  saveItems(
    app.harness.deps.db,
    "6f1c7a52-9b3e-4f8a-9c2d-71b0a5d4e8c6",
    "gmail",
    [
      {
        id: "mail-project-prep",
        source: "gmail",
        title: "프로젝트 회의 자료 준비",
        at: new Date(now).toISOString(),
        detail: "회의 전에 제안서와 근거 자료를 함께 검토합니다.",
        url: "https://mail.example.invalid/project",
      },
    ],
    now,
  );
  saveItems(
    app.harness.deps.db,
    "canvas-default",
    "canvas",
    [
      {
        id: "canvas-api-assignment",
        source: "canvas",
        title: "Canvas 검색 과제",
        at: new Date(now + 86_400_000).toISOString(),
        detail: "검색 전략을 비교하는 짧은 과제입니다.",
        url: "https://canvas.example.invalid/assignments/1",
      },
    ],
    now,
  );
  const sources = await app.request("/api/whiteboard?limit=100", { token });
  const sourceBody = DocumentList.parse(await responseBody(sources));
  receipts.push({ action: "project-sources", status: sources.status, body: sourceBody });
  if (!sourceBody.documents.some((document) => document.path.startsWith("records/canvas/"))) {
    throw new Error("missing_canvas_projection");
  }
  if (!sourceBody.documents.some((document) => document.path.startsWith("records/gmail/"))) {
    throw new Error("missing_mail_projection");
  }
  const note = await documentPost(app, token, {
    path: "threads/notes/current-presentation",
    kind: "thread",
    title: "현재 발표 일정",
    text: "발표는 14시에 시작합니다.",
  });
  const task = await documentPost(app, token, {
    path: "commitments/notes/search-review",
    kind: "commitment",
    title: "검색 결과 검토",
    text: "오늘 저장한 검색 결과를 확인합니다.",
  });
  const taskDocument = DocumentResponse.parse(task.body).document;
  receipts.push({ action: "create-note", ...note }, { action: "create-task", ...task });
  if (task.status !== 201 || note.status !== 201) throw new Error("whiteboard_create_failed");
  const updateResponse = await app.request(
    `/api/whiteboard/${encodeURIComponent(taskDocument.id)}`,
    {
      token,
      method: "PATCH",
      body: { expectedHash: taskDocument.hash, status: "in_progress" },
    },
  );
  const updated = DocumentResponse.parse(await responseBody(updateResponse));
  receipts.push({ action: "update-task", status: updateResponse.status, body: updated });
  if (updated.document.status !== "in_progress") throw new Error("task_update_failed");
  const badPath = await documentPost(app, token, {
    path: "threads/../../outside",
    kind: "thread",
    title: "outside",
    text: "refused",
  });
  receipts.push({ action: "refuse-traversal", ...badPath });
  if (badPath.status !== 422) throw new Error("traversal_was_not_refused");
  const list = DocumentList.parse(
    await responseBody(await app.request("/api/whiteboard?query=회의", { token })),
  );
  if (!list.documents.some((document) => document.id)) throw new Error("whiteboard_search_empty");

  const boardRoot = `${app.root}/workspace/whiteboard`;
  const files = filesBelow(boardRoot).filter((path) => path.endsWith(".md"));
  const audit = files.map((path) => {
    const raw = readFileSync(join(boardRoot, path), "utf8");
    const match = /^---\n([\s\S]*?)\n---\n/.exec(raw);
    if (!match?.[1]) throw new Error(`frontmatter_missing_${path}`);
    const metadata = WhiteboardFrontmatterSchema.parse(JSON.parse(match[1]));
    return { path: path.replaceAll("\\", "/"), metadata, bytes: raw.length };
  });
  if (audit.length < 8) throw new Error("whiteboard_projection_incomplete");
  await saveEvidence(evidenceDir, "http.json", receipts);
  await saveEvidence(evidenceDir, "fs.json", { boardRoot, documents: audit });
  const browser = await runBrowserCapture("whiteboard", app.baseUrl, evidenceDir);
  await saveEvidence(evidenceDir, "browser.json", browser);
  console.log(`whiteboard QA PASS (${audit.length} documents)`);
} finally {
  const cleanup = await app.stop();
  await saveEvidence(evidenceDir, "cleanup.json", cleanup);
}
