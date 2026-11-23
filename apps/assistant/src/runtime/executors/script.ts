import type { Database } from "bun:sqlite";
import { z } from "zod";
import { SandboxRequest, SandboxResult, type ScriptManifest } from "../../contracts/tools";

export class ScriptDenied extends Error {
  constructor(readonly kind: "not_approved" | "collector_scope" | "sandbox_unavailable" | "sandbox_rejected") {
    super(kind);
    this.name = "ScriptDenied";
  }
}

export type ScriptResult = {
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly truncated: boolean;
  readonly outputs: readonly { readonly path: string; readonly sha256: string; readonly bytes: number }[];
};

/**
 * A generated script may only run when its artifact digest is the active,
 * user-approved tool version. There is no local fallback: without a sandbox
 * runner the call fails instead of executing the script on the host.
 */
export function assertApproved(db: Database, manifest: ScriptManifest): void {
  const row = db.query(
    "SELECT active FROM tool_versions WHERE tool_id = ? AND artifact_digest = ?",
  ).get(manifest.id, manifest.artifactDigest);
  const state = z.object({ active: z.number() }).safeParse(row);
  if (!state.success || state.data.active !== 1) throw new ScriptDenied("not_approved");
}

export function sandboxRequest(
  manifest: ScriptManifest, image: string, argv: readonly string[], inputName?: string,
): SandboxRequest {
  return SandboxRequest.parse({
    image,
    entrypoint: "main.ts",
    argv: [...argv],
    timeoutMs: manifest.timeoutMs,
    maxOutputBytes: manifest.maxOutputBytes,
    memoryMb: manifest.memoryMb,
    cpus: manifest.cpus,
    pidsLimit: manifest.pidsLimit,
    ...(inputName === undefined ? {} : { inputName }),
  });
}

export async function runScript(
  db: Database,
  input: {
    readonly manifest: ScriptManifest;
    readonly image: string;
    readonly argv: readonly string[];
    readonly inputName?: string;
  },
  options: { readonly runnerUrl: string | undefined; readonly runnerToken: string | undefined },
): Promise<ScriptResult> {
  if (input.manifest.kind === "generated") assertApproved(db, input.manifest);
  const request = sandboxRequest(input.manifest, input.image, input.argv, input.inputName);
  if (!options.runnerUrl || !options.runnerToken) throw new ScriptDenied("sandbox_unavailable");
  const response = await fetch(new URL("/run", options.runnerUrl), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${options.runnerToken}` },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(request.timeoutMs + 30_000),
  });
  if (response.status === 401 || response.status === 400) throw new ScriptDenied("sandbox_rejected");
  if (!response.ok) throw new ScriptDenied("sandbox_unavailable");
  const result = SandboxResult.parse(await response.json());
  return result;
}
