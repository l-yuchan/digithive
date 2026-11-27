import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { write } from "bun";
import type { OmowrightModule, Page } from "./browser-types";

/**
 * The browser half of the settings QA: drives the real page with omowright on the
 * installed Chrome, and records every navigation, assertion and screenshot.
 *
 *   bun scripts/qa/settings-driver.ts <baseUrl> <evidenceDir>
 *
 * `OMOWRIGHT_MODULE`, `QA_PASSPHRASE` and `QA_PROVIDER_BASE` come from the parent script.
 */
function isOmowrightModule(value: unknown): value is OmowrightModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "loadOmowright" in value &&
    typeof value.loadOmowright === "function"
  );
}

function evidenceDirectoryOf(value: string | undefined): string {
  if (!value) throw new Error("usage: settings-driver.ts <baseUrl> <evidenceDir>");
  return value;
}

const [baseUrl, evidenceDir] = process.argv.slice(2);
if (!baseUrl) throw new Error("usage: settings-driver.ts <baseUrl> <evidenceDir>");
const outDir = evidenceDirectoryOf(evidenceDir);

const modulePath = process.env["OMOWRIGHT_MODULE"];
if (!modulePath) throw new Error("OMOWRIGHT_MODULE is required");
const passphrase = process.env["QA_PASSPHRASE"] ?? "";
const providerBase = process.env["QA_PROVIDER_BASE"] ?? "";

const loaded: unknown = await import(`file:///${modulePath.replaceAll("\\", "/")}`);
if (!isOmowrightModule(loaded)) throw new Error("omowright loader missing");
const { omowright } = await loaded.loadOmowright();

const chrome = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((path) => existsSync(path));
if (chrome === undefined) throw new Error("CHROME_PATH: no installed Chrome found");

const profile = mkdtempSync(join(tmpdir(), "digithive-settings-browser-"));
const browser = await omowright.connectPipe({
  browserPath: chrome,
  browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${profile}`],
  storageRoot: profile,
});
const page = await browser.newTab("about:blank");
const evidence: Record<string, unknown>[] = [];
const record = (entry: Record<string, unknown>) => {
  evidence.push(entry);
};

function pathOf(target: Page): Promise<string> {
  return target.evaluate(() => window.location.pathname);
}

async function rendered(): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((complete) =>
        requestAnimationFrame(() => requestAnimationFrame(() => complete())),
      ),
  );
}

async function waitForText(text: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await page.evaluate(() => document.body.innerText);
    if (body.includes(text)) return;
    await new Promise((complete) => setTimeout(complete, 200));
  }
  throw new Error(`missing browser text: ${text}`);
}

async function capture(name: string): Promise<void> {
  await rendered();
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  if (overflow.document > overflow.viewport)
    throw new Error(`horizontal overflow on ${name}: ${JSON.stringify(overflow)}`);
  await write(resolve(outDir, name), await page.screenshot());
  record({ capture: name, url: await pathOf(page), overflow });
}

async function click(testId: string): Promise<void> {
  await page.locator(`[data-testid="${testId}"]`).click();
  await rendered();
}

async function fill(testId: string, value: string): Promise<void> {
  await page.locator(`[data-testid="${testId}"]`).fill(value);
}

try {
  // ── login through the real gate ────────────────────────────────────────────
  await page.goto(`${baseUrl}/settings`, { waitUntil: "load" });
  await rendered();
  await fill("passphrase", passphrase);
  await page.locator('[data-testid="login-submit"]').click();
  await waitForText("설정");

  // ── C1: one settings tab, the overview, every child, legacy address ────────
  const tabs = await page.evaluate(() =>
    [...document.querySelectorAll("nav.tabs a")].map((link) => link.textContent?.trim() ?? ""),
  );
  const tabBarIsOneSettingsTab = tabs.includes("설정") && !tabs.includes("연결");
  record({ assertion: "one-settings-tab", tabs, pass: tabBarIsOneSettingsTab });
  if (!tabBarIsOneSettingsTab)
    throw new Error("the 연결 tab is still in the tab bar, or 설정 is gone");
  await waitForText("모델 공급자, 계정 연결, 알림, 브리핑");
  record({
    assertion: "overview",
    url: await pathOf(page),
    pass: (await pathOf(page)) === "/settings",
  });
  await capture("01-overview.png");

  const children: [string, string, string][] = [
    ["providers", "모델 공급자", "02-providers"],
    ["accounts", "계정", "03-accounts"],
    ["push", "알림", "04-push"],
    ["briefings", "브리핑", "05-briefings"],
  ];
  for (const [child, label, shot] of children) {
    await click(`settings-child-${child}`);
    await waitForText(label);
    // The address is the state: a child is its own URL.
    const at = await pathOf(page);
    record({ assertion: "child-route", child, url: at, pass: at === `/settings/${child}` });
    if (at !== `/settings/${child}`) throw new Error(`child ${child} landed on ${at}`);
    await capture(`${shot}.png`);
  }

  // A hard reload of a child answers with the shell and lands on that child again.
  await page.reload({ waitUntil: "load" });
  await waitForText("최근 브리핑");
  const reloadedAt = await pathOf(page);
  record({
    assertion: "child-reload",
    url: reloadedAt,
    pass: reloadedAt === "/settings/briefings",
  });
  if (reloadedAt !== "/settings/briefings") throw new Error(`reload landed on ${reloadedAt}`);

  // The address the 연결 tab used to live at reaches the accounts part.
  await page.goto(`${baseUrl}/connections`, { waitUntil: "load" });
  await waitForText("계정");
  await rendered();
  const legacyAt = await pathOf(page);
  record({
    assertion: "legacy-connections-redirect",
    url: legacyAt,
    pass: legacyAt === "/settings/accounts",
  });
  if (legacyAt !== "/settings/accounts") throw new Error("legacy /connections did not redirect");

  // ── C4: an arbitrary OpenAI-compatible provider, from the screen ───────────
  await page.goto(`${baseUrl}/settings/providers`, { waitUntil: "load" });
  await waitForText("모델 경로");
  await click("provider-add-open");
  await waitForText("공급자 추가");
  // The base URL and the key are typed into labelled fields, never filled from the
  // placeholder: an empty value would silently fall back to nothing.
  await page.locator('[aria-label="base URL"]').fill(providerBase);
  await page.locator('[aria-label="API 키"]').fill("qa-ui-key-4321");
  await fill("provider-label", "QA 로컬 서버");
  await click("provider-save");
  await waitForText("QA 로컬 서버");
  await waitForText("qa-model-fast");
  record({ assertion: "custom-provider-added", pass: true });
  await capture("06-provider-added.png");

  // Its models are listed, adding one to the chain works, and a real answer is proven.
  await click("model-chain-add-qa-model-strong");
  await waitForText("QA 로컬 서버 · ");
  await click("model-test-qa-model-strong");
  await waitForText("응답");
  record({ assertion: "model-answer-test", pass: true });

  // A model the provider refuses is reported with the provider's own words.
  await click("model-test-qa-model-broken");
  await waitForText("retired (fixture)");
  record({ assertion: "model-test-failure-verbatim", pass: true });
  await capture("07-model-listed-and-tested.png");

  // The chain order is the routing order: the added model moved up first.
  const order = await page.evaluate(() =>
    [
      ...document.querySelectorAll('[data-testid="model-chain-list"] [data-testid="chain-row"]'),
    ].map((row) => row.getAttribute("data-model-id") ?? ""),
  );
  record({
    assertion: "chain-order",
    order,
    pass: order.length === 2 && order[0] === "qa-model-fast",
  });
  await page.locator('[data-testid="chain-up-qa-model-strong"]').click();
  await waitForText("모델 경로");
  const reordered = await page.evaluate(() =>
    [
      ...document.querySelectorAll('[data-testid="model-chain-list"] [data-testid="chain-row"]'),
    ].map((row) => row.getAttribute("data-model-id") ?? ""),
  );
  record({
    assertion: "chain-reorder-persists",
    order: reordered,
    pass: reordered[0] === "qa-model-strong",
  });
  if (reordered[0] !== "qa-model-strong")
    throw new Error(`chain order not saved: ${reordered.join(",")}`);
  await capture("08-chain-reordered.png");

  // ── C6: a key never comes back to the page ─────────────────────────────────
  const pageText = await page.evaluate(() => document.body.innerText);
  const keyLeaked = pageText.includes("qa-ui-key-4321") || pageText.includes("qa-seed-key-0000");
  record({ assertion: "no-key-on-screen", pass: !keyLeaked });
  if (keyLeaked) throw new Error("a provider key is visible on the page");

  // ── mobile width: the same screen must not overflow ────────────────────────
  await omowright.emulate(page, "iphone-14");
  await rendered();
  await capture("09-providers-mobile.png");
  await omowright.emulate(page, null);

  await write(resolve(outDir, "browser-actions.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`settings browser QA PASS (${evidence.length} checks, provider ${providerBase})`);
} catch (error) {
  const diagnostic = {
    message: error instanceof Error ? error.message : String(error),
    url: await pathOf(page).catch(() => "unavailable"),
    dom: await page.evaluate(() => document.body.innerText).catch(() => "unavailable"),
  };
  await write(resolve(outDir, "browser-error.json"), `${JSON.stringify(diagnostic, null, 2)}\n`);
  await write(
    resolve(outDir, "browser-error.png"),
    await page.screenshot().catch(() => new Uint8Array()),
  );
  await write(resolve(outDir, "browser-actions.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  throw error;
} finally {
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
  await write(
    resolve(outDir, "browser-cleanup.json"),
    `${JSON.stringify({ browserClosed: true, profileRemoved: !existsSync(profile) }, null, 2)}\n`,
  );
}
