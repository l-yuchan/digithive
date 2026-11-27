import { z } from "zod";
import { createWebSearchService, searchConfigFromEnv } from "../../src/search";
import type { AgentFixtureMessage } from "./agent-model";
import { modelText, modelToolCall, startAgentModel } from "./agent-model";
import { evidenceArgument, responseBody, saveEvidence, startQaHarness } from "./harness-fixture";
import { DAILY_SEARCH_WORKFLOW_ID } from "../../src/workflows/system-workflows";

const QUERY = "OpenAI API documentation";
const SearchReports = z.object({
  results: z.array(z.object({ title: z.string(), url: z.string() })),
  failures: z.array(z.object({ provider: z.string(), kind: z.string(), message: z.string() })),
  archives: z.array(z.object({ id: z.string(), path: z.string() })),
});
const RunResponse = z.object({
  run: z.object({ id: z.string(), status: z.string() }),
  workflow: z.object({ id: z.string(), title: z.string() }),
});

function latestTool(messages: readonly AgentFixtureMessage[]) {
  const message = messages.at(-1);
  if (message?.role !== "tool") throw new Error(`expected_tool_result: ${message?.role}`);
  return message.content;
}

const evidenceDir = evidenceArgument();
const configured = searchConfigFromEnv({ ...process.env, SEARCH_ENABLE_CLI: "true" });
const providers = [];
for (const provider of ["tinyfish", "firecrawl", "duckduckgo"] as const) {
  const result = await createWebSearchService({ config: configured }).search({
    query: QUERY,
    provider,
    limit: 3,
  });
  providers.push(result);
  if (!result.ok || result.results.length === 0) {
    await saveEvidence(evidenceDir, "providers.json", providers);
    throw new Error(`configured_provider_unavailable_${provider}`);
  }
}
await saveEvidence(evidenceDir, "providers.json", providers);

const failingProviders = Bun.serve({
  port: 0,
  fetch: () => Response.json({ error: "QA provider unavailable" }, { status: 503 }),
});
const failingPort = failingProviders.port;
if (failingPort === undefined) throw new Error("provider_fixture_no_port");
process.env["TINYFISH_API_KEY"] = "qa-unavailable";
process.env["FIRECRAWL_API_KEY"] = "qa-unavailable";
process.env["TINYFISH_API_URL"] = `http://127.0.0.1:${failingPort}/`;
process.env["FIRECRAWL_API_URL"] = `http://127.0.0.1:${failingPort}`;
process.env["SEARCH_ENABLE_CLI"] = "false";
process.env["DUCKDUCKGO_HTML_URL"] = "https://html.duckduckgo.com/html/";

const model = startAgentModel((messages, call) => {
  switch (call) {
    case 1:
      return modelToolCall("whiteboard_list", { kind: "thread", limit: 10 });
    case 2:
      return modelToolCall("web_search", { query: QUERY, provider: "all", limit: 2 });
    case 3: {
      const result = SearchReports.parse(JSON.parse(latestTool(messages)));
      if (result.results.length === 0) throw new Error("daily_search_returned_no_hits");
      if (result.archives.length === 0) throw new Error("daily_search_archived_nothing");
      const failed = result.failures.map((failure) => failure.provider);
      if (!failed.includes("tinyfish") || !failed.includes("firecrawl")) {
        throw new Error("provider_failures_were_hidden");
      }
      return modelToolCall("whiteboard_write", {
        path: "threads/research/2026-11-27-daily-qa",
        kind: "thread",
        title: "일일 OpenAI 문서 조사",
        text: [
          "OpenAI 공식 문서를 확인해 현재 개발 문서를 요약합니다.",
          "자료를 읽지 못한 TinyFish와 Firecrawl 오류는 결과에서 제외하지 않았습니다.",
          `원문 기록: ${result.archives.map((archive) => archive.path).join(", ")}`,
          `발견 URL: ${result.results.map((hit) => hit.url).join(", ")}`,
        ].join("\n\n"),
      });
    }
    case 4:
      return modelText("검색 결과와 제공자 오류를 화이트보드에 저장했습니다.");
    default:
      throw new Error(`unexpected_model_round_${call}`);
  }
});
const app = await startQaHarness({ name: "daily-search", modelBaseUrl: model.baseUrl });
let run: Awaited<ReturnType<typeof app.run>> = null;
try {
  const token = await app.login();
  const response = await app.request(
    `/api/workflows/${encodeURIComponent(DAILY_SEARCH_WORKFLOW_ID)}/run`,
    { token, method: "POST", body: { args: {} } },
  );
  const queued = RunResponse.parse(await responseBody(response));
  run = await app.run(queued.run.id);
  await saveEvidence(evidenceDir, "run.json", run);
  await saveEvidence(evidenceDir, "model-requests.json", model.requests);
  if (run?.status !== "succeeded") throw new Error(`daily_run_failed_${run?.status}`);
  const archived = await app.request("/api/whiteboard?query=OpenAI&limit=100", { token });
  const archiveBody = await responseBody(archived);
  await saveEvidence(evidenceDir, "whiteboard-files.json", archiveBody);
  const schedule = app.harness.deps.db
    .query<
      { id: string; workflow_id: string; trigger_json: string; next_run_at: string | null },
      []
    >(
      "SELECT id,workflow_id,trigger_json,next_run_at FROM schedules WHERE id='system:daily-search:06:30'",
    )
    .get();
  await saveEvidence(evidenceDir, "schedule.json", schedule);
  if (schedule?.workflow_id !== DAILY_SEARCH_WORKFLOW_ID) throw new Error("daily_schedule_missing");
  const rawFiles = app.harness.deps.db
    .query("SELECT path FROM whiteboard_documents WHERE path LIKE 'records/web/%'")
    .all();
  const digest = app.harness.deps.db
    .query(
      "SELECT path FROM whiteboard_documents WHERE path='threads/research/2026-11-27-daily-qa.md'",
    )
    .get();
  if (rawFiles.length === 0 || !digest) throw new Error("daily_whiteboard_files_missing");
  console.log(`daily search QA PASS (${rawFiles.length} raw records)`);
} finally {
  const harnessCleanup = await app.stop();
  const modelCleanup = await model.close();
  const failedPort = failingProviders.port;
  await failingProviders.stop(true);
  if (failedPort !== undefined) {
    const rebound = Bun.serve({ port: failedPort, fetch: () => new Response(null) });
    await rebound.stop(true);
  }
  const failedProviderPortReleased = failedPort !== undefined;
  await saveEvidence(evidenceDir, "cleanup.json", {
    ...harnessCleanup,
    ...modelCleanup,
    failedProviderPortReleased,
  });
}
