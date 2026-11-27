import { z } from "zod";
import { saveItems } from "../../src/integrations/sync-store";
import { BRIEFING_WORKFLOW_ID } from "../../src/workflows/system-workflows";
import { modelText, modelToolCall, startAgentModel } from "./agent-model";
import type { AgentFixtureMessage } from "./agent-model";
import { responseBody, startQaHarness } from "./harness-fixture";

const ACCOUNT = "6f1c7a52-9b3e-4f8a-9c2d-71b0a5d4e8c6";
const id = (messages: readonly AgentFixtureMessage[]): string => {
  const last = messages.at(-1);
  if (!last || last.role !== "tool") throw new Error("missing_tool_result");
  const body = z
    .union([
      z.object({ documents: z.array(z.object({ id: z.string(), path: z.string() })) }),
      z.object({ id: z.string(), text: z.string() }),
    ])
    .parse(JSON.parse(last.content));
  if ("documents" in body) {
    const current = body.documents.find(
      (document) => document.path === "threads/notes/presentation-time.md",
    );
    if (!current) throw new Error("current_preview_note_missing");
    return current.id;
  }
  return body.id;
};

const model = startAgentModel((messages, call) => {
  switch (call) {
    case 1:
      return modelToolCall("whiteboard_list", { query: "발표", limit: 5 });
    case 2:
      return modelToolCall("whiteboard_read", { id: id(messages) });
    case 3:
      return modelToolCall("briefing_publish", {
        text: "오늘 발표는 14시에 진행됩니다. 자료를 미리 검토하세요.",
        sourceIds: [id(messages)],
        slot: "07:30",
      });
    case 4:
      return modelToolCall("push_send", {
        title: "digithive 브리핑 07:30",
        body: "오늘 발표는 14시에 진행됩니다. 자료를 미리 검토하세요.",
      });
    default:
      return modelText("검토용 자연어 브리핑을 저장했습니다.");
  }
});
const app = await startQaHarness({
  name: "manual-preview",
  modelBaseUrl: model.baseUrl,
  port: 8799,
  hostname: "0.0.0.0",
});
let closed = false;
async function closePreview(): Promise<void> {
  if (closed) return;
  closed = true;
  await model.close();
  await app.stop();
}
function exitAfterClose(code: number): void {
  closePreview().then(
    () => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
process.once("SIGINT", () => exitAfterClose(0));
process.once("SIGTERM", () => exitAfterClose(0));

try {
  const token = await app.login();
  const now = Date.now();
  saveItems(
    app.harness.deps.db,
    ACCOUNT,
    "gmail",
    [
      {
        id: "preview-mail",
        source: "gmail",
        title: "발표 자료 검토 요청",
        at: new Date(now).toISOString(),
        detail: "발표 전에 근거 자료를 함께 검토합시다.",
        url: null,
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
        id: "preview-assignment",
        source: "canvas",
        title: "검색 비교 과제",
        at: new Date(now + 86_400_000).toISOString(),
        detail: "세 검색 제공자의 특성을 비교하여 제출합니다.",
        url: null,
      },
    ],
    now,
  );
  await app.request("/api/whiteboard", {
    token,
    method: "POST",
    body: {
      path: "threads/notes/presentation-time",
      kind: "thread",
      title: "현재 발표 일정",
      text: "발표는 14시에 시작합니다.",
    },
  });
  await app.request("/api/whiteboard", {
    token,
    method: "POST",
    body: {
      path: "commitments/notes/review-materials",
      kind: "commitment",
      title: "발표 자료 검토",
      text: "자료의 근거와 링크를 확인합니다.",
    },
  });
  const response = await app.request(
    `/api/workflows/${encodeURIComponent(BRIEFING_WORKFLOW_ID)}/run`,
    {
      token,
      method: "POST",
      body: { args: {} },
    },
  );
  const queued = z
    .object({ run: z.object({ id: z.string() }) })
    .parse(await responseBody(response));
  const completed = await app.run(queued.run.id);
  if (completed?.status !== "succeeded") throw new Error("preview_briefing_failed");
  console.log(`\nREVIEW URL: http://127.0.0.1:${app.server.port}/whiteboard`);
  console.log("PASSPHRASE: qa-whiteboard-passphrase");
  console.log("Isolated synthetic data only. Stop through the agent when review is complete.\n");
  await new Promise<never>(() => {});
} catch (error) {
  exitAfterClose(1);
  throw error;
}
