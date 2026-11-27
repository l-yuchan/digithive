import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import process from "node:process";
import { join, resolve } from "node:path";
import { write } from "bun";
import { saveStaticSnapshot } from "./snapshot";
import type { NetworkSnoop, OmowrightModule, Page } from "./browser-types";

function isOmowrightModule(value: unknown): value is OmowrightModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "loadOmowright" in value &&
    typeof value.loadOmowright === "function"
  );
}

const [mode, baseUrl, outDir] = process.argv.slice(2);
if (!mode || !baseUrl || !outDir) throw new Error("usage: browser-driver.ts <mode> <base> <dir>");
const modulePath = process.env["OMOWRIGHT_MODULE"];
if (!modulePath) throw new Error("OMOWRIGHT_MODULE is required");
const candidates = [
  process.env["CHROME_PATH"],
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].filter((path): path is string => typeof path === "string");
const browserPath = candidates.find((path) => existsSync(path));
if (!browserPath) throw new Error("CHROME_PATH is required: no installed Chrome found");
const outputDirectory: string = outDir;
const baseUrlValue: string = baseUrl;
const browserModule: unknown = await import(
  modulePath.startsWith("file:") ? modulePath : `file:///${modulePath.replaceAll("\\", "/")}`
);
if (!isOmowrightModule(browserModule)) throw new Error("omowright loader missing");
const { omowright } = await browserModule.loadOmowright();
const profile = mkdtempSync(join(tmpdir(), "digithive-browser-readonly-"));
const actions: Record<string, unknown>[] = [];
const browser = await omowright.connectPipe({
  browserPath,
  browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${profile}`],
  storageRoot: profile,
});
let page: Page | undefined;
let snoop: NetworkSnoop | undefined;
let sessionId = "";
const pendingResponses = new Set<Promise<unknown>>();

function surface(): Page {
  if (!page) throw new Error("browser page unavailable");
  return page;
}
function expectResponse(match: Record<string, unknown>): Promise<unknown> {
  if (!snoop) throw new Error("network snoop unavailable");
  const pending = snoop.waitFor(match, { timeoutMs: 15_000 });
  pendingResponses.add(pending);
  pending.then(
    () => pendingResponses.delete(pending),
    () => pendingResponses.delete(pending),
  );
  return pending;
}
async function rendered() {
  await surface().evaluate(
    () =>
      new Promise<void>((complete) =>
        requestAnimationFrame(() => requestAnimationFrame(() => complete())),
      ),
  );
}
async function snapshotText(): Promise<string> {
  return surface().evaluate(() =>
    [
      document.body.innerText,
      ...[...document.querySelectorAll("textarea")].map((field) => field.value),
    ].join("\n"),
  );
}
async function assertText(expected: string) {
  await surface().evaluate(
    (wanted) =>
      new Promise<void>((complete, reject) => {
        const ready = () =>
          document.body.innerText.includes(wanted) ||
          [...document.querySelectorAll("textarea")].some((field) => field.value.includes(wanted));
        if (ready()) return complete();
        const timer = setTimeout(() => {
          observer.disconnect();
          reject(new Error(`missing browser text: ${wanted}`));
        }, 15_000);
        const observer = new MutationObserver(() => {
          if (!ready()) return;
          clearTimeout(timer);
          observer.disconnect();
          complete();
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      }),
    expected,
  );
  actions.push({ assertion: "text-present", expected, pass: true });
}
async function capture(file: string) {
  const overflow = await surface().evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  if (overflow.document > overflow.viewport) {
    throw new Error(`horizontal overflow: ${JSON.stringify(overflow)}`);
  }
  await write(resolve(outputDirectory, file), await surface().screenshot());
  await saveStaticSnapshot(surface(), baseUrlValue, outputDirectory, file);
  actions.push({ capture: file, overflow, pass: true });
}
async function scheme(value: string) {
  await surface().cdp.send(
    "Emulation.setEmulatedMedia",
    { features: [{ name: "prefers-color-scheme", value }] },
    sessionId,
  );
}

try {
  page = await browser.newTab("about:blank");
  sessionId = await page.resolveSessionId();
  snoop = omowright.createNetworkSnoop(page, { maxBodyBytes: 256 * 1024 });
  await omowright.emulate(page, "desktop-1440");
  const sessionResponse = expectResponse({ url: /\/api\/session/ });
  await page.goto(`${baseUrlValue}/whiteboard`, { waitUntil: "load" });
  await sessionResponse;
  await rendered();
  const loginResponse = expectResponse({ url: /\/api\/login/ });
  const listResponse = expectResponse({ url: /\/api\/whiteboard\?/ });
  await page.locator('[data-testid="passphrase"]').fill(process.env["QA_PASSPHRASE"]);
  await page.locator('[data-testid="login-submit"]').click();
  await Promise.all([loginResponse, listResponse]);
  await rendered();
  await assertText("화이트보드");
  if (mode === "whiteboard") {
    for (const text of ["프로젝트 회의 자료 준비", "Canvas 검색 과제", "검색 결과 검토"]) {
      await assertText(text);
    }
    await page.locator('[data-testid="whiteboard-path"]').fill("threads/notes/browser-proof");
    await page.locator('[data-testid="whiteboard-title"]').fill("브라우저 저장 증거");
    await page
      .locator('[data-testid="whiteboard-content"]')
      .fill("실제 브라우저로 저장한 화이트보드 문서입니다.");
    const routes = omowright.createRoutes(page);
    await routes.route("**/api/whiteboard", (route) =>
      route.fulfill({ status: 500, body: "injected QA failure" }),
    );
    const failedPost = expectResponse({ url: /\/api\/whiteboard$/, method: "POST" });
    await page.locator('[data-testid="whiteboard-save"]').click();
    await failedPost;
    await rendered();
    await assertText("요청 오류");
    await routes.dispose();
    const savedPost = expectResponse({ url: /\/api\/whiteboard$/, method: "POST" });
    await page.locator('[data-testid="whiteboard-save"]').click();
    await savedPost;
    await rendered();
    await assertText("브라우저 저장 증거");
    await capture("desktop.png");
    await scheme("dark");
    await rendered();
    await capture("desktop-dark.png");
    await scheme("light");
    const reloadList = expectResponse({ url: /\/api\/whiteboard\?/ });
    await page.reload({ waitUntil: "load" });
    await reloadList;
    await rendered();
    await assertText("브라우저 저장 증거");
    actions.push({ assertion: "selection-survives-reload", pass: true });
    await omowright.emulate(page, "iphone-14");
    await rendered();
    await capture("mobile.png");
    await scheme("dark");
    await rendered();
    await capture("mobile-dark.png");
    await scheme("light");
  } else {
    const briefingSelected = await page.evaluate(() => {
      for (const row of document.querySelectorAll('[data-testid="whiteboard-document"]')) {
        const title = row.querySelector("strong")?.textContent?.trim() ?? "";
        if (/^브리핑 \d{2}:\d{2}$/.test(title)) {
          row.querySelector("button")?.click();
          return true;
        }
      }
      return false;
    });
    if (!briefingSelected) throw new Error("persisted briefing row missing");
    await rendered();
    await assertText("14시");
    await assertText("브리핑");
    await capture("desktop.png");
    await scheme("dark");
    await rendered();
    await capture("desktop-dark.png");
    await scheme("light");
    await omowright.emulate(page, "iphone-14");
    await rendered();
    await capture("mobile.png");
  }
  await write(resolve(outputDirectory, "actions.json"), `${JSON.stringify(actions, null, 2)}\n`);
  console.log(`${mode} browser QA PASS (${actions.length} checks)`);
} catch (error) {
  const diagnostic = {
    message: error instanceof Error ? error.message : String(error),
    dom: await snapshotText().catch(() => "unavailable"),
  };
  await write(
    resolve(outputDirectory, "browser-error.json"),
    `${JSON.stringify(diagnostic, null, 2)}\n`,
  );
  if (page) {
    await write(resolve(outputDirectory, "browser-error.png"), await page.screenshot());
  }
  throw error;
} finally {
  await Promise.allSettled(pendingResponses);
  snoop?.dispose();
  if (page) await omowright.emulate(page, null);
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
  await write(
    resolve(outputDirectory, "browser-cleanup.json"),
    `${JSON.stringify({ browserClosed: true, profileRemoved: !existsSync(profile), snoopDisposed: true }, null, 2)}\n`,
  );
}
