import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export type ScriptExecution = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly truncated: boolean;
};

const OUTPUT_LIMIT = 64_000;

function contained(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path !== ".." &&
    !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(path)
  );
}

/**
 * Resolves a script inside the configured root. Absolute paths, traversal and
 * symlinks that escape the real root are rejected before the process starts.
 */
export function resolveScriptPath(scriptsRoot: string, path: string): string {
  if (path.length === 0 || isAbsolute(path)) throw new Error("script_path_outside_root");
  if (!existsSync(scriptsRoot)) throw new Error("scripts_root_unavailable");
  const root = realpathSync(scriptsRoot);
  const target = resolve(root, path);
  if (!contained(root, target)) throw new Error("script_path_outside_root");
  if (!existsSync(target)) throw new Error("script_not_found");
  const real = realpathSync(target);
  if (!contained(root, real)) throw new Error("script_path_outside_root");
  if (!/\.(ts|js|mjs|cjs)$/.test(real)) throw new Error("script_extension_not_supported");
  return real;
}

async function collect(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let truncated = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (text.length >= limit) {
        truncated = true;
        continue;
      }
      const chunk = decoder.decode(next.value, { stream: true });
      const room = limit - text.length;
      text += chunk.slice(0, room);
      if (chunk.length > room) truncated = true;
    }
    text += decoder.decode();
  } finally {
    try {
      await reader.cancel();
    } catch {
      // the process may already have closed the pipe
    }
  }
  return { text, truncated };
}

/**
 * Runs a local `.ts`/`.js` file with Bun, no shell, bounded output, and the run
 * signal wired to an actual process kill. It never touches the model provider.
 */
export async function runScriptFile(input: {
  readonly scriptsRoot: string;
  readonly path: string;
  readonly args: readonly string[];
  readonly signal: AbortSignal;
  /** Extra environment for this run only (the SDK bridge URL and its token). */
  readonly env?: Readonly<Record<string, string>>;
}): Promise<ScriptExecution> {
  const script = resolveScriptPath(input.scriptsRoot, input.path);
  if (input.signal.aborted) throw input.signal.reason;
  const proc = Bun.spawn({
    cmd: [process.execPath, script, ...input.args],
    cwd: resolve(input.scriptsRoot),
    env: { ...process.env, ...input.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const kill = () => {
    try {
      proc.kill("SIGKILL");
    } catch {
      // already exited
    }
  };
  input.signal.addEventListener("abort", kill, { once: true });
  if (input.signal.aborted) kill();
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      collect(proc.stdout as ReadableStream<Uint8Array>, OUTPUT_LIMIT),
      collect(proc.stderr as ReadableStream<Uint8Array>, OUTPUT_LIMIT),
      proc.exited,
    ]);
    if (input.signal.aborted) throw input.signal.reason ?? new Error("run_cancelled");
    return {
      stdout: stdout.text,
      stderr: stderr.text,
      exitCode,
      truncated: stdout.truncated || stderr.truncated,
    };
  } finally {
    input.signal.removeEventListener("abort", kill);
    if (proc.exitCode === null) kill();
  }
}
