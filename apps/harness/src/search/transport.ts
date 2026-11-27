import type { ProviderFailure, ProviderFailureKind } from "./types";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type CliResult = {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

export type CliRunner = (
  cmd: readonly string[],
  options: { readonly signal?: AbortSignal },
) => Promise<CliResult>;

export const CLI_OUTPUT_LIMIT = 200_000;
export const REQUEST_TIMEOUT_MS = 20_000;

export class SearchProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly kind: ProviderFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "SearchProviderError";
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function failureOf(provider: string, error: unknown): ProviderFailure {
  if (error instanceof SearchProviderError)
    return { provider, kind: error.kind, message: error.message };
  if (error instanceof Error && error.name === "AbortError")
    return { provider, kind: "aborted", message: "aborted" };
  return { provider, kind: "transport", message: messageOf(error) };
}

/** A request signal that always has a deadline and still follows the caller's abort. */
export function requestSignal(signal: AbortSignal | undefined): AbortSignal {
  const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

export function httpUrl(raw: string | null | undefined): string | null {
  const text = raw?.trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

export async function readJson(response: Response, provider: string): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new SearchProviderError(provider, "malformed", "response is not JSON");
    throw error;
  }
}

/** Runs a provider CLI without a shell. A missing or failing command is visible. */
export const defaultCliRunner: CliRunner = async (cmd, options) => {
  try {
    const proc = Bun.spawn({
      cmd: [...cmd],
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
    options.signal?.addEventListener("abort", kill, { once: true });
    if (options.signal?.aborted) kill();
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return {
        exitCode,
        stdout: stdout.slice(0, CLI_OUTPUT_LIMIT),
        stderr: stderr.slice(0, CLI_OUTPUT_LIMIT),
      };
    } finally {
      options.signal?.removeEventListener("abort", kill);
    }
  } catch (error) {
    return { exitCode: null, stdout: "", stderr: messageOf(error) };
  }
};

/** Throw when a CLI did not run or did not succeed, naming the provider. */
export function assertCliSuccess(provider: string, result: CliResult): void {
  if (result.exitCode === 0) return;
  const detail = result.stderr.trim().slice(0, 300);
  throw new SearchProviderError(
    provider,
    "provider_unavailable",
    result.exitCode === null
      ? `cli_unavailable: ${detail || "command not found"}`
      : `cli_exit_${result.exitCode}: ${detail || "no stderr"}`,
  );
}
