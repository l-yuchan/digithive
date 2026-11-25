/**
 * Example workflow script: read its own parameters through the SDK, search memory,
 * and print a JSON summary that becomes the run's result.
 *
 * Register it as a script workflow:
 *   { kind: "script", path: "jobs/example-workflow.ts", capabilities: ["memory.read"] }
 * with a parameter such as { name: "keyword", type: "string", default: "회의" }.
 */
import { sdk } from "../.digithive/sdk.ts";

type Parameters = { keyword?: string };

const context = await sdk.context();
const params = context.params as Parameters;
const keyword = params.keyword ?? "회의";
const hits = await sdk.memory.recall(keyword);

console.log(
  JSON.stringify(
    {
      runId: context.runId,
      workflow: context.workflowTitle,
      keyword,
      matches: Array.isArray(hits) ? hits.length : 0,
      hits,
    },
    null,
    2,
  ),
);
