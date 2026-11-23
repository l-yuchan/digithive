import { z } from "zod";

export const CanvasConfig = z.object({
  binary: z.string().min(1),
  host: z.string().min(1),
  courseAllowlist: z.array(z.number().int().positive()).min(1),
});
export type CanvasConfig = z.infer<typeof CanvasConfig>;

export class CanvasCliError extends Error {
  constructor(readonly kind: "auth_required" | "forbidden" | "not_found" | "invalid_json" | "cli_failed" | "unsupported") {
    super(kind);
    this.name = "CanvasCliError";
  }
}

/** Minimal process surface so the CLI invocation can be exercised with a fake
 * child process in tests without weakening the real spawn path. */
export type CliSpawn = (
  command: readonly string[],
  options: { readonly env: Record<string, string | undefined>; readonly stdout: "pipe"; readonly stderr: "pipe" },
) => {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(): void;
};

export const defaultSpawn: CliSpawn = (command, options) => Bun.spawn([...command], options);

const ALLOWED_SUBCOMMANDS = new Set(["api"]);
const FORBIDDEN_FLAGS = new Set(["--as-user", "--token", "--verbose-debug", "--post", "--put", "--delete"]);

export function canvasConfig(): CanvasConfig {
  const host = process.env["CANVAS_HOST"] ?? "lxp-canvas.hanyang.ac.kr";
  const binary = process.env["CANVAS_BIN"] ?? "canvas";
  const allow = (process.env["CANVAS_COURSES"] ?? "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
  return CanvasConfig.parse({ binary, host, courseAllowlist: allow.length > 0 ? allow : [1] });
}

/** Only `api GET <allowlisted path>` may be built: no arbitrary subcommand, no
 * shell string, no identity switch and no write verb ever reaches the CLI. */
export function buildArgs(path: string): readonly string[] {
  if (!path.startsWith("/api/v1/")) throw new CanvasCliError("unsupported");
  if (path.includes("..") || /[;|`$<>]/.test(path)) throw new CanvasCliError("unsupported");
  const args = ["api", "GET", path, "--paginate", "-o", "json", "--no-cache"];
  for (const arg of args) {
    if (FORBIDDEN_FLAGS.has(arg)) throw new CanvasCliError("unsupported");
  }
  if (!ALLOWED_SUBCOMMANDS.has(args[0] ?? "")) throw new CanvasCliError("unsupported");
  return args;
}

export function isCourseAllowed(config: CanvasConfig, courseId: number): boolean {
  return config.courseAllowlist.includes(courseId);
}

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export async function runCanvasCli(
  config: CanvasConfig, path: string, options: { readonly timeoutMs?: number; readonly spawn?: CliSpawn } = {},
): Promise<unknown> {
  const args = buildArgs(path);
  const spawn = options.spawn ?? defaultSpawn;
  let child: ReturnType<CliSpawn>;
  try {
    child = spawn([config.binary, ...args], {
      env: { ...process.env, CANVAS_HOST: config.host },
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    if (error instanceof Error) throw new CanvasCliError("cli_failed");
    throw error;
  }
  const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 30_000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text().catch(() => ""),
    new Response(child.stderr).text().catch(() => ""),
    child.exited,
  ]);
  clearTimeout(timer);
  if (stdout.length > MAX_OUTPUT_BYTES) throw new CanvasCliError("invalid_json");
  if (code !== 0) {
    const lowered = `${stdout}${stderr}`.toLowerCase();
    if (lowered.includes("401") || lowered.includes("unauthor")) throw new CanvasCliError("auth_required");
    if (lowered.includes("403") || lowered.includes("forbidden")) throw new CanvasCliError("forbidden");
    if (lowered.includes("404") || lowered.includes("not found")) throw new CanvasCliError("not_found");
    throw new CanvasCliError("cli_failed");
  }
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (parsed !== null && typeof parsed === "object" && "status" in parsed && "body" in parsed) {
      const envelope = z.object({ status: z.number(), body: z.unknown() }).parse(parsed);
      if (envelope.status === 401) throw new CanvasCliError("auth_required");
      if (envelope.status === 403) throw new CanvasCliError("forbidden");
      if (envelope.status === 404) throw new CanvasCliError("not_found");
      if (envelope.status >= 400) throw new CanvasCliError("cli_failed");
      return envelope.body;
    }
    return parsed;
  } catch (error) {
    if (error instanceof CanvasCliError) throw error;
    if (error instanceof SyntaxError || error instanceof z.ZodError) throw new CanvasCliError("invalid_json");
    throw error;
  }
}

export async function cliStatus(config: CanvasConfig, spawn: CliSpawn = defaultSpawn): Promise<{ ok: boolean; version: string }> {
  const child = spawn([config.binary, "version"], {
    env: { ...process.env, CANVAS_HOST: config.host }, stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 10_000);
  const text = await new Response(child.stdout).text().catch(() => "");
  const code = await child.exited;
  clearTimeout(timer);
  return { ok: code === 0, version: text.split("\n")[0]?.trim() ?? "" };
}
