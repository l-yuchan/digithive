import { z } from "zod";
import { saveItems } from "../../src/integrations/sync-store";
import {
  evidenceArgument,
  responseBody,
  runBrowserCapture,
  saveEvidence,
  startQaHarness,
} from "./harness-fixture";
import { modelText, modelToolCall, startAgentModel } from "./agent-model";
import type { AgentFixtureMessage } from "./agent-model";
import { BRIEFING_WORKFLOW_ID } from "../../src/workflows/system-workflows";

const DocumentList = z.object({
  documents: z.array(z.object({ id: z.string(), path: z.string() })),
});
const DocumentResponse = z.object({ id: z.string(), text: z.string() });
const Published = z.object({
  stored: z.boolean(),
  prompt: z.object({ title: z.string(), body: z.string() }).nullable(),
});
const RunResponse = z.object({ run: z.object({ id: z.string(), status: z.string() }) });
const PushResult = z.object({ sent: z.number(), errors: z.array(z.string()) });
let forceModelFailure = false;
let currentSourceId = "";

function latestTool(messages: readonly AgentFixtureMessage[]) {
  const message = messages.at(-1);
  if (message?.role !== "tool") throw new Error(`expected_tool_result: ${message?.role}`);
  return message.content;
}

const evidenceDir = evidenceArgument();
const model = startAgentModel((messages, call) => {
  if (forceModelFailure) return modelText("");
  switch (call) {
    case 1:
      return modelToolCall("whiteboard_list", { query: "발표", limit: 20 });
    case 2: {
      const rows = DocumentList.parse(JSON.parse(latestTool(messages))).documents;
      const current = rows.find((row) => row.path === "threads/notes/presentation-time.md");
      if (!current) throw new Error("current_whiteboard_fact_missing");
      return modelToolCall("whiteboard_read", { id: current.id });
    }
    case 3: {
      const document = DocumentResponse.parse(JSON.parse(latestTool(messages)));
      if (!document.text.includes("14시")) throw new Error("current_fact_not_read");
      currentSourceId = document.id;
      return modelToolCall("briefing_publish", {
        text: "오늘 발표는 14시에 진행됩니다. 필요한 자료를 미리 준비하세요.",
        sourceIds: [document.id],
        slot: "07:30",
      });
    }
    case 4: {
      const published = Published.parse(JSON.parse(latestTool(messages)));
      if (!published.stored || !published.prompt) throw new Error("briefing_not_stored");
      return modelToolCall("push_send", published.prompt);
    }
    case 5: {
      const pushed = PushResult.parse(JSON.parse(latestTool(messages)));
      if (pushed.sent !== 0 || !pushed.errors.includes("push_unconfigured")) {
        throw new Error("unexpected_push_result");
      }
      return modelText("화이트보드 브리핑을 저장했고 알림 미설정 상태를 확인했습니다.");
    }
    default:
      throw new Error(`unexpected_briefing_round_${call}`);
  }
});
const app = await startQaHarness({ name: "agent-briefing", modelBaseUrl: model.baseUrl });
let completedRun: Awaited<ReturnType<typeof app.run>> = null;
let failedRun: Awaited<ReturnType<typeof app.run>> = null;
try {
  const token = await app.login();
  saveItems(
    app.harness.deps.db,
    "6f1c7a52-9b3e-4f8a-9c2d-71b0a5d4e8c6",
    "gmail",
    [
      {
        id: "stale-presentation",
        source: "gmail",
        title: "이전 발표 일정",
        at: "2025-01-01T00:00:00.000Z",
        detail: "발표는 10시에 시작합니다.",
        url: null,
      },
    ],
    Date.parse("2025-01-01T00:00:00.000Z"),
  );
  app.harness.deps.db
    .query("UPDATE account_sources SET enabled=0 WHERE account_id=? AND source='gmail'")
    .run("6f1c7a52-9b3e-4f8a-9c2d-71b0a5d4e8c6");
  const seed = await app.request("/api/whiteboard", {
    token,
    method: "POST",
    body: {
      path: "threads/notes/presentation-time",
      kind: "thread",
      title: "현재 발표 일정",
      text: "발표는 14시에 시작합니다.",
    },
  });
  if (seed.status !== 201) throw new Error("current_fact_seed_failed");
  const runWorkflow = async () => {
    const response = await app.request(
      `/api/workflows/${encodeURIComponent(BRIEFING_WORKFLOW_ID)}/run`,
      { token, method: "POST", body: { args: {} } },
    );
    const queued = RunResponse.parse(await responseBody(response));
    return { queued, completed: await app.run(queued.run.id) };
  };
  const first = await runWorkflow();
  completedRun = first.completed;
  if (completedRun?.status !== "succeeded") throw new Error("briefing_run_failed");
  const latest = z
    .object({
      content: z.object({ runId: z.string(), text: z.string(), references: z.array(z.string()) }),
    })
    .parse(await responseBody(await app.request("/api/briefings/latest", { token })));
  if (latest.content.runId !== first.queued.run.id) throw new Error("briefing_run_link_missing");
  if (!latest.content.text.includes("14시") || latest.content.text.includes("10시")) {
    throw new Error("briefing_used_stale_context");
  }
  if (!latest.content.references.includes(currentSourceId)) {
    throw new Error("briefing_citation_missing");
  }
  if (JSON.stringify(model.requests).includes("10시")) {
    throw new Error("disabled_stale_source_reached_agent");
  }
  const push = PushResult.parse(JSON.parse(latestTool(model.requests[4]?.messages ?? [])));
  await saveEvidence(evidenceDir, "latest.json", latest);
  await saveEvidence(evidenceDir, "push.json", push);
  const count = () =>
    app.harness.deps.db
      .query<{ count: number }, []>("SELECT count(*) AS count FROM briefings")
      .get()?.count;
  const beforeFailure = count();
  forceModelFailure = true;
  const second = await runWorkflow();
  failedRun = second.completed;
  if (failedRun?.status !== "failed") throw new Error("empty_model_output_became_success");
  const afterFailure = count();
  if (beforeFailure !== 1 || afterFailure !== 1) {
    throw new Error("empty_model_output_added_briefing");
  }
  await saveEvidence(evidenceDir, "run.json", { completedRun, failedRun });
  await saveEvidence(evidenceDir, "model-requests.json", model.requests);
  await saveEvidence(
    evidenceDir,
    "whiteboard-files.json",
    await responseBody(await app.request("/api/whiteboard?query=브리핑", { token })),
  );
  await runBrowserCapture("briefing", app.baseUrl, evidenceDir);
  console.log("agentic briefing QA PASS");
} finally {
  const harnessCleanup = await app.stop();
  const modelCleanup = await model.close();
  await saveEvidence(evidenceDir, "cleanup.json", { ...harnessCleanup, ...modelCleanup });
}
