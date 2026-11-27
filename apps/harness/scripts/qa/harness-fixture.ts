import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHarness, loadConfig } from "../../src/server/main";
import { claimNext } from "../../src/surfaces/work/runner";
import { executeRun } from "../../src/surfaces/work/execution";
import { getRun } from "../../src/surfaces/work/record";

export type QaHarness = Awaited<ReturnType<typeof startQaHarness>>;

export async function startQaHarness(input: {
  readonly name: string;
  readonly modelBaseUrl: string;
  readonly port?: number;
  readonly hostname?: string;
}) {
  const root = mkdtempSync(join(tmpdir(), `digithive-${input.name}-`));
  const harness = createHarness(
    loadConfig({
      HARNESS_DB: join(root, "db.sqlite"),
      HARNESS_WORKSPACE: join(root, "workspace"),
      HARNESS_PASSPHRASE: "qa-whiteboard-passphrase",
      HARNESS_SESSION_SECRET: "qa-whiteboard-session-secret",
      MODEL_BASE_URL: input.modelBaseUrl,
      MODEL_NAME: "fixture-agent",
      MODEL_RETRIES: "0",
      MODEL_FALLBACKS_JSON: "[]",
      SEARCH_ENABLE_CLI: process.env["SEARCH_ENABLE_CLI"],
    }),
  );
  const server = Bun.serve({
    port: input.port ?? 0,
    hostname: input.hostname ?? "127.0.0.1",
    idleTimeout: 0,
    fetch: harness.handler,
  });
  const port = server.port;
  if (port === undefined) {
    await server.stop(true);
    harness.close();
    rmSync(root, { recursive: true, force: true });
    throw new Error("qa_no_listen_port");
  }
  const baseUrl = `http://127.0.0.1:${port}`;
  const request = async (
    path: string,
    options: { readonly token?: string; readonly method?: string; readonly body?: unknown } = {},
  ) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...(options.token ? { cookie: options.token } : {}),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        origin: baseUrl,
        host: `127.0.0.1:${port}`,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    return response;
  };
  return {
    harness,
    server,
    baseUrl,
    root,
    request,
    login: async () => {
      const response = await request("/api/login", {
        method: "POST",
        body: { passphrase: "qa-whiteboard-passphrase" },
      });
      if (response.status !== 200) throw new Error(`qa_login_${response.status}`);
      const token = response.headers.get("set-cookie")?.split(";")[0];
      if (!token) throw new Error("qa_login_cookie_missing");
      return token;
    },
    run: async (runId: string) => {
      const claimed = claimNext(harness.deps.db, harness.deps.events, `qa-${process.pid}`);
      if (!claimed || claimed.id !== runId) throw new Error(`qa_run_not_claimed_${runId}`);
      await executeRun(harness.work, claimed);
      return getRun(harness.deps.db, runId);
    },
    stop: async () => {
      await server.stop(true);
      harness.close();
      // A successful bind proves the old listener is gone before temp files are removed.
      const rebound = Bun.serve({ port, fetch: () => new Response(null) });
      await rebound.stop(true);
      rmSync(root, { recursive: true, force: true });
      return { portReleased: true, rootRemoved: !existsSync(join(root, "db.sqlite")) };
    },
  };
}

export async function saveEvidence(directory: string, name: string, value: unknown) {
  const path = join(directory, name);
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

export async function runBrowserCapture(
  mode: "whiteboard" | "briefing",
  baseUrl: string,
  directory: string,
) {
  const child = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "browser-driver.ts"), mode, baseUrl, directory],
    {
      env: { ...process.env, QA_PASSPHRASE: "qa-whiteboard-passphrase" },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`browser_capture_failed_${mode}_${exitCode}`);
  return { browserCompleted: true };
}

export async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function evidencePath(input: string): string {
  if (process.argv.includes("--evidence-dir") && input.trim().length > 0) {
    return resolve(process.cwd(), input);
  }
  throw new Error("qa_evidence_dir_required");
}

export function evidenceArgument(): string {
  const index = process.argv.indexOf("--evidence-dir");
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value) throw new Error("usage: <script> --evidence-dir <path>");
  return evidencePath(value);
}
