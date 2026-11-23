import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { ScriptManifest } from "../../src/contracts/tools";
import { runScript } from "../../src/runtime/executors/script";

type SandboxContext = {
  readonly db: Database;
  readonly evidence: string;
};

function settings(): { runnerUrl: string; runnerToken: string } {
  const runnerUrl = process.env["QA_SANDBOX_URL"];
  const runnerToken = process.env["QA_SANDBOX_TOKEN"];
  assert.ok(runnerUrl, "QA_SANDBOX_URL must point at a live sandbox runner");
  assert.ok(runnerToken, "QA_SANDBOX_TOKEN must carry the runner token");
  return { runnerUrl, runnerToken };
}

const manifest = (kind: "collector" | "generated", digest: string, timeoutMs: number): ScriptManifest =>
  ScriptManifest.parse({
    id: "sandbox-probe", kind, artifactDigest: digest,
    timeoutMs, maxOutputBytes: 65_536, memoryMb: 128, cpus: 0.5, pidsLimit: 32,
  });

const digest = (letter: string): string => `sha256:${letter.repeat(64)}`;

export async function scriptApproved(context: SandboxContext): Promise<void> {
  const runner = settings();
  const approved = digest("c");
  context.db.query("INSERT INTO tool_versions (id,tool_id,artifact_digest,active,approved_by) VALUES (?,?,?,?,?)")
    .run("tv-sandbox", "sandbox-probe", approved, 1, "user");

  const result = await runScript(context.db, {
    manifest: manifest("generated", approved, 20_000),
    image: "dg-script:base",
    argv: ["--uppercase", "hello sandbox"],
    inputName: "transform",
  }, runner);
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 0);
  const output = result.outputs.find((entry) => entry.path === "result.txt");
  assert.ok(output, `expected result.txt, saw ${JSON.stringify(result.outputs)}`);
  assert.equal(output.bytes, "HELLO SANDBOX\n".length);
  assert.match(result.stdout, /TRANSFORMED/);
  await writeFile(join(context.evidence, "result.json"), `${JSON.stringify({
    exitCode: result.exitCode, timedOut: result.timedOut, stdout: result.stdout.trim(),
    outputs: result.outputs,
  }, null, 2)}\n`);
  await writeFile(join(context.evidence, "transcript.txt"), `${result.stdout}\n`);

  await assert.rejects(async () => runScript(context.db, {
    manifest: manifest("generated", digest("d"), 20_000),
    image: "dg-script:base",
    argv: [],
    inputName: "transform",
  }, runner), /not_approved/);
}

export async function scriptEscapeAndTimeout(context: SandboxContext): Promise<void> {
  const runner = settings();
  const approved = digest("e");
  context.db.query("INSERT INTO tool_versions (id,tool_id,artifact_digest,active,approved_by) VALUES (?,?,?,?,?)")
    .run("tv-escape", "sandbox-probe", approved, 1, "user");

  const escape = await runScript(context.db, {
    manifest: manifest("generated", approved, 30_000),
    image: "dg-script:base",
    argv: [],
    inputName: "escape",
  }, runner);
  assert.equal(escape.exitCode, 0, `escape probe exited ${escape.exitCode}: ${escape.stdout}`);
  const probe = JSON.parse(escape.stdout.trim()) as Record<string, unknown>;
  assert.equal(probe["secret_read"], "blocked");
  assert.equal(probe["network"], "blocked");
  assert.equal(probe["rootfs_write"], "blocked");
  assert.equal(probe["uid"], 65534);

  const timeout = await runScript(context.db, {
    manifest: manifest("generated", approved, 3_000),
    image: "dg-script:base",
    argv: [],
    inputName: "spin",
  }, runner);
  assert.equal(timeout.timedOut, true);
  assert.equal(timeout.exitCode, -1);

  await writeFile(join(context.evidence, "sandbox.json"), `${JSON.stringify({
    escape: probe, timeout: { timedOut: timeout.timedOut, exitCode: timeout.exitCode },
  }, null, 2)}\n`);
}
