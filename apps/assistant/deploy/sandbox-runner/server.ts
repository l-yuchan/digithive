import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, chmod } from "node:fs/promises";
import { join, relative } from "node:path";
import { SandboxRequest, type SandboxResult } from "../../src/contracts/tools";

const PORT = Number(process.env["RUNNER_PORT"] ?? 4400);
const TOKEN = process.env["RUNNER_TOKEN"];
const ROOT = process.env["SANDBOX_ROOT"] ?? "/work";
// Path the Docker daemon sees for the same volume. They differ only when the
// runner container mounts the sandbox volume at a different host path.
const HOST_ROOT = process.env["SANDBOX_HOST_ROOT"] ?? ROOT;
const IMAGE_PREFIX = process.env["SANDBOX_IMAGE_PREFIX"] ?? "dg-script:";
const MAX_OUTPUT_FILES = 64;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

if (!TOKEN || TOKEN.length < 16) {
  console.error("RUNNER_TOKEN must be set to at least 16 characters");
  process.exit(1);
}

await mkdir(join(ROOT, "runs"), { recursive: true });

class Rejected extends Error {}

async function docker(args: readonly string[]): Promise<{ code: number; out: string }> {
  const process = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text().catch(() => ""),
    new Response(process.stderr).text().catch(() => ""),
    process.exited,
  ]);
  return { code, out: stdout + stderr };
}

/** Waits for the container to stop, enforcing the deadline without relying on
 * the attached CLI process, which does not reliably forward termination. */
async function waitForExit(name: string, deadline: number): Promise<boolean> {
  for (;;) {
    const state = await docker(["inspect", "-f", "{{.State.Running}}", name]);
    if (state.out.trim() !== "true") return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(200);
  }
}

async function collect(directory: string): Promise<SandboxResult["outputs"]> {
  const names = await readdir(directory, { withFileTypes: true });
  const files: SandboxResult["outputs"] = [];
  let total = 0;
  for (const name of names.sort((left, right) => left.name.localeCompare(right.name)).slice(0, MAX_OUTPUT_FILES)) {
    const path = join(directory, name.name);
    const info = await stat(path);
    if (!name.isFile() || total + info.size > MAX_OUTPUT_BYTES) continue;
    const contents = await readFile(path);
    total += info.size;
    files.push({ path: name.name, sha256: createHash("sha256").update(contents).digest("hex"), bytes: info.size });
  }
  return files;
}

async function run(request: SandboxRequest): Promise<SandboxResult> {
  if (!/^(dg-script|dg-collector):[a-z0-9._-]{1,80}$/.test(request.image) ||
    !request.image.startsWith(IMAGE_PREFIX)) {
    throw new Rejected("image not allowed");
  }
  if (!/^[a-z0-9_]{1,40}\.ts$/.test(request.entrypoint)) throw new Rejected("entrypoint not allowed");
  const work = await mkdtemp(join(ROOT, "runs", "run-"));
  const out = join(work, "out");
  await mkdir(out, { recursive: true });
  await chmod(out, 0o777);
  const hostOut = join(HOST_ROOT, relative(ROOT, out));
  const name = `dg-${crypto.randomUUID()}`;
  const input = request.inputName ? ["-v", `${join(HOST_ROOT, "inputs", request.inputName)}:/in:ro`] : [];
  const args = [
    "run", "-d", "--name", name, "--network", "none", "--read-only",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", String(request.pidsLimit), "--memory", `${request.memoryMb}m`,
    "--cpus", String(request.cpus), "--user", "65534:65534",
    "--ulimit", "nofile=64",
    ...input, "-v", `${hostOut}:/out:rw`,
    request.image, "bun", `/in/${request.entrypoint}`, ...request.argv,
  ];
  try {
    const started = await docker(args);
    if (started.code !== 0) {
      return { exitCode: started.code, timedOut: false, stdout: started.out.slice(0, 2_048), truncated: false, outputs: [] };
    }
    const finished = await waitForExit(name, Date.now() + request.timeoutMs);
    if (!finished) {
      await docker(["kill", name]);
      return { exitCode: -1, timedOut: true, stdout: "", truncated: false, outputs: [] };
    }
    const inspect = await docker(["inspect", "-f", "{{.State.ExitCode}}", name]);
    const output = await docker(["logs", name]);
    const limit = request.maxOutputBytes;
    return {
      exitCode: Number(inspect.out.trim()),
      timedOut: false,
      stdout: output.out.slice(0, limit),
      truncated: output.out.length > limit,
      outputs: await collect(out),
    };
  } finally {
    await docker(["rm", "-f", name]);
    await rm(work, { recursive: true, force: true });
  }
}

const server = Bun.serve({
  hostname: "0.0.0.0",
  port: PORT,
  async fetch(request) {
    if (request.method === "GET" && new URL(request.url).pathname === "/health") {
      const version = await docker(["version", "--format", "{{.Server.Version}}"]);
      return Response.json({ ok: version.code === 0, docker: version.out.trim().slice(0, 40) });
    }
    if (request.method !== "POST" || new URL(request.url).pathname !== "/run") {
      return new Response("not found", { status: 404 });
    }
    if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
      return new Response("unauthorized", { status: 401 });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return new Response("invalid json", { status: 400 });
    }
    const parsed = SandboxRequest.safeParse(body);
    if (!parsed.success) return new Response("invalid request", { status: 400 });
    try {
      return Response.json(await run(parsed.data));
    } catch (error) {
      if (error instanceof Rejected) return new Response(error.message, { status: 400 });
      console.error("sandbox run failed", error instanceof Error ? error.message : "unknown error");
      return new Response("runner failure", { status: 500 });
    }
  },
});

console.log(`sandbox runner listening on ${server.hostname}:${server.port}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { server.stop(); process.exit(0); });
}
