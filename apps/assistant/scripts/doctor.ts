import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";

const Config = z.object({
  dataRoot: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).optional(),
}).strict();

type Check = {
  readonly id: string;
  readonly status: "READY" | "NEEDS_SETUP";
  readonly detail: string;
};

class PreflightError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PreflightError";
  }
}

function options(args: readonly string[]): { mode: "local" | "live"; json: boolean; config?: string } {
  let mode: "local" | "live" = "local";
  let json = false;
  let config: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const item = args[index];
    if (item === "--mode") {
      const value = args[++index];
      if (value !== "local" && value !== "live") {
        throw new PreflightError("invalid_mode", "Expected --mode local or live");
      }
      mode = value;
    } else if (item === "--config") {
      config = args[++index];
      if (!config) {
        throw new PreflightError("invalid_config", "Expected a path after --config");
      }
    } else if (item === "--json") {
      json = true;
    } else if (item !== "--") {
      throw new PreflightError("invalid_option", `Unrecognized option: ${item}`);
    }
  }
  return config === undefined ? { mode, json } : { mode, json, config };
}

function executable(id: string, command: string): Check {
  const result = spawnSync(command, ["--version"], {
    timeout: 2000,
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    id,
    status: result.status === 0 ? "READY" : "NEEDS_SETUP",
    detail: result.status === 0 ? "Executable available" : "Executable unavailable or timed out",
  };
}

async function writable(root: string): Promise<Check> {
  try {
    await mkdir(root, { recursive: true });
    const probe = await mkdtemp(resolve(root, ".doctor-"));
    try {
      await writeFile(resolve(probe, "write-check"), "ok", { flag: "wx" });
    } finally {
      await rm(probe, { recursive: true });
    }
    return { id: "data_volume", status: "READY", detail: "Writable data boundary" };
  } catch (error) {
    if (error instanceof Error) {
      return { id: "data_volume", status: "NEEDS_SETUP", detail: "Data boundary is not writable" };
    }
    throw error;
  }
}

async function portAvailable(port: number): Promise<Check> {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", () => done({ id: "port", status: "NEEDS_SETUP", detail: "Port unavailable" }));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => done({ id: "port", status: "READY", detail: "Loopback port available" }));
    });
  });
}

function set(id: string, value: string | undefined): Check {
  return { id, status: value ? "READY" : "NEEDS_SETUP", detail: value ? "Configured" : "Configuration missing" };
}

function origin(value: string | undefined): Check {
  if (value) {
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && url.origin === value && !url.username && !url.password) {
        return { id: "app_origin", status: "READY", detail: "HTTPS origin configured" };
      }
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
  }
  return { id: "app_origin", status: "NEEDS_SETUP", detail: "An exact HTTPS origin is required" };
}

async function main(): Promise<void> {
  const input = options(process.argv.slice(2));
  const data = input.config
    ? Config.parse(JSON.parse(await readFile(resolve(input.config), "utf8")))
    : Config.parse({});
  const root = resolve(data.dataRoot ?? process.env["ASSISTANT_DATA_ROOT"] ?? resolve(tmpdir(), "digithive-assistant"));
  const port = data.port ?? 4317;
  const checks: Check[] = [
    { id: "bun", status: typeof Bun.version === "string" ? "READY" : "NEEDS_SETUP", detail: `Bun ${Bun.version}` },
    { id: "os", status: "READY", detail: process.platform },
    await writable(root),
    await portAvailable(port),
    executable("docker", "docker"),
    executable("canvas", "canvas"),
    set("lockfile", await Bun.file("bun.lock").exists() ? "present" : undefined),
  ];

  if (input.mode === "live") {
    checks.push(
      { id: "linux_target", status: process.platform === "linux" ? "READY" : "NEEDS_SETUP", detail: process.platform === "linux" ? "Linux host" : "Deploy on a Linux host" },
      origin(process.env["APP_ORIGIN"]),
      ...["PASSPHRASE_HASH", "SESSION_KEY", "ENCRYPTION_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "VAPID_PRIVATE_KEY", "MODEL_API_KEY", "MODEL_BASE_URL", "MODEL_NAME", "SEARCH_API_KEY"].map((key) => set(key.toLowerCase(), process.env[key])),
      { id: "provider_capabilities", status: "NEEDS_SETUP", detail: "Live text/tool calling and price revision not yet verified" },
      { id: "search_capabilities", status: "NEEDS_SETUP", detail: "Live search/scrape availability and price not yet verified" },
    );
  }

  const required = input.mode === "local"
    ? ["bun", "os", "data_volume", "port", "lockfile"]
    : checks.map((check) => check.id);
  const missing = checks.filter((check) => required.includes(check.id) && check.status !== "READY").map((check) => check.id);
  const report = {
    status: missing.length === 0 ? "READY" : "NEEDS_SETUP",
    mode: input.mode,
    checks,
    missing,
    externalRequests: 0,
  };
  console.log(input.json ? JSON.stringify(report) : JSON.stringify(report, null, 2));
  if (missing.length > 0) process.exitCode = 1;
}

try {
  await main();
} catch (error) { // no-excuse-ok: catch
  const detail = error instanceof PreflightError ? error.code : error instanceof z.ZodError ? "invalid_config" : "preflight_failed";
  console.log(JSON.stringify({ status: "NEEDS_SETUP", error: detail, externalRequests: 0 }));
  process.exitCode = 1;
}
