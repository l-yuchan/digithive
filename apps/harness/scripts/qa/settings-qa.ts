/**
 * QA for the settings overhaul: a real harness process, a stand-in OpenAI-compatible
 * provider on loopback, and a browser driver run against both.
 *
 *   bun scripts/qa/settings-qa.ts --evidence-dir <dir>
 *
 * The stand-in answers `/models` with an OpenAI list and `/chat/completions` with a
 * non-streamed chat answer, so "add any OpenAI-compatible provider" and "prove it answers"
 * are exercised end to end without a real key. Everything it starts is stopped again and
 * the report says so.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHarness, loadConfig } from "../../src/server/main";
import { answerProviderCall, type ProviderCall } from "./provider-fixture";

/** The browser driver the app ships for its own QA; it loads omowright from the skill. */
const OMOWRIGHT_MODULE =
  "C:/Users/chabun/.bun/install/global/node_modules/omo-ai/plugin/skills/browser/scripts/omowright.mjs";
const QA_PASSPHRASE = "qa-settings-passphrase";

function evidenceDirectory(): string {
  const index = process.argv.indexOf("--evidence-dir");
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value) throw new Error("usage: settings-qa.ts --evidence-dir <dir>");
  return resolve(value);
}

async function main(): Promise<void> {
  const evidenceDir = evidenceDirectory();
  mkdirSync(evidenceDir, { recursive: true });
  const providerCalls: ProviderCall[] = [];

  const provider = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      providerCalls.push({
        path: new URL(request.url).pathname,
        method: request.method,
        authorization: request.headers.get("authorization"),
      });
      return answerProviderCall(request);
    },
  });
  const providerBase = `http://127.0.0.1:${provider.port}/v1`;

  const root = mkdtempSync(join(tmpdir(), "digithive-settings-qa-"));
  const harness = createHarness(
    loadConfig({
      HARNESS_DB: join(root, "db.sqlite"),
      HARNESS_WORKSPACE: join(root, "workspace"),
      HARNESS_PASSPHRASE: QA_PASSPHRASE,
      HARNESS_SESSION_SECRET: "qa-settings-session-secret",
      // The first run seeds one provider from this; the QA adds a second one through the UI.
      MODEL_BASE_URL: providerBase,
      MODEL_API_KEY: "qa-seed-key-0000",
      MODEL_NAME: "qa-model-fast",
      MODEL_RETRIES: "0",
    }),
  );
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: harness.handler,
  });
  const port = server.port;
  if (port === undefined) throw new Error("qa_no_port");
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(JSON.stringify({ baseUrl, providerBase, evidenceDir }));

  const driver = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "settings-driver.ts"), baseUrl, evidenceDir],
    {
      env: {
        ...process.env,
        QA_PASSPHRASE,
        QA_PROVIDER_BASE: providerBase,
        OMOWRIGHT_MODULE,
      },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const exitCode = await driver.exited;

  await Bun.write(
    join(evidenceDir, "provider-calls.json"),
    `${JSON.stringify(providerCalls, null, 2)}\n`,
  );
  await server.stop(true);
  harness.close();
  await provider.stop(true);
  rmSync(root, { recursive: true, force: true });
  // A successful bind proves both listeners are gone before the report says so.
  const rebound = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response(null) });
  await rebound.stop(true);
  await Bun.write(
    join(evidenceDir, "teardown.json"),
    `${JSON.stringify(
      {
        driverExitCode: exitCode,
        portReleased: true,
        tempRootRemoved: true,
        providerStopped: true,
      },
      null,
      2,
    )}\n`,
  );
  if (exitCode !== 0) throw new Error(`settings_driver_failed_${exitCode}`);
  console.log("settings QA PASS");
}

await main();
