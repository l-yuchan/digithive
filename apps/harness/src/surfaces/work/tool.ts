import { decide } from "../../core/policy";
import { ownsLease } from "./lease";
import type { WorkDeps, RunRow } from "./runner";
import { z } from "zod";

type Call = { readonly id: string; readonly name: string; readonly arguments: string };

function argumentsOf(call: Call): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(JSON.parse(call.arguments || "{}"));
}

export function toolDecision(
  deps: WorkDeps,
  call: Call,
  profile?: string,
): "allow" | "ask" | "deny" {
  const tool = deps.tools.get(call.name);
  if (!tool || (profile === "read-only" && tool.action !== "read")) return "deny";
  const args = argumentsOf(call);
  const decision = decide(deps.policy, {
    action: tool.action,
    resource: z.string().parse(args["path"] ?? args["summary"] ?? "*"),
  });
  // Nobody is present to approve while an inline workflow call runs inside the
  // caller's tool slot, so "ask" becomes a refusal the model can read.
  if (profile === "inline" && decision === "ask") return "deny";
  return decision;
}

export async function executeTool(
  deps: WorkDeps,
  run: RunRow,
  call: Call,
  signal: AbortSignal,
): Promise<{ output: string; timeout?: boolean }> {
  const tool = deps.tools.get(call.name);
  if (!tool) throw new Error("unknown_tool");
  if (signal.aborted || !ownsLease(deps.db, run.id, run.leaseOwner, (deps.now ?? Date.now)()))
    throw new Error("lease_lost");
  const args = argumentsOf(call);
  const toolMs = deps.limits?.toolMs ?? 30_000;
  const started = Date.now();
  const storedId = `${run.id}:${call.id}`;
  deps.db
    .query(
      "INSERT OR REPLACE INTO tool_calls (id,run_id,name,arguments_json,decision,status,started_at,deadline_at) VALUES (?,?,?,?,?,?,?,?)",
    )
    .run(
      storedId,
      run.id,
      call.name,
      call.arguments,
      "allow",
      "running",
      new Date(started).toISOString(),
      new Date(started + toolMs).toISOString(),
    );
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let output = "";
  let status = "succeeded";
  try {
    output = await Promise.race([
      tool.execute(args, { runId: run.id, signal: controller.signal }),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
          once: true,
        });
        // A self-deadlined tool (inline workflow run) bounds itself by the caller's budget.
        if (tool.selfDeadline !== true)
          timer = setTimeout(() => controller.abort(new Error("tool_timeout")), toolMs);
      }),
    ]);
  } catch (error) {
    if (signal.aborted) throw error;
    status = controller.signal.aborted ? "timeout" : "failed";
    output =
      status === "timeout"
        ? "도구 실행 시간이 초과되었습니다."
        : `도구 실행 실패: ${error instanceof Error ? error.message : "unknown"}`;
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    deps.db
      .query("UPDATE tool_calls SET status=?,ended_at=? WHERE id=? AND run_id=?")
      .run(signal.aborted ? "interrupted" : status, new Date().toISOString(), storedId, run.id);
  }
  return { output, ...(status === "timeout" ? { timeout: true } : {}) };
}
