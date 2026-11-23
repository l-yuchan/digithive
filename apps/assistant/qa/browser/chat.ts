import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Locator = { fill(value: string): Promise<void>; click(): Promise<void> };
type Page = {
  goto(url: string): Promise<unknown>;
  locator(selector: string): Locator;
  screenshot(): Promise<Uint8Array>;
  evaluate<T>(fn: (testId: string) => T, testId: string): Promise<T>;
};

type Browser = {
  newTab(url: string): Promise<unknown>;
  close(): Promise<void>;
};

type Omowright = {
  connectPipe(options: Record<string, unknown>): Promise<unknown>;
  emulate(page: unknown, preset: string): Promise<unknown>;
};

export type BrowserContext = {
  readonly base: string;
  readonly evidence: string;
  readonly passphrase: string;
};

function modulePath(): string {
  const configured = process.env["OMOWRIGHT_MODULE"];
  if (!configured) throw new Error("OMOWRIGHT_MODULE must point at the browser skill's omowright.mjs");
  return configured;
}

async function connect(): Promise<{ page: Page; browser: Browser; omowright: Omowright; close(): Promise<void> }> {
  const module = await import(modulePath()) as { loadOmowright(): Promise<{ omowright: Omowright }> };
  const { omowright } = await module.loadOmowright();
  const profile = await mkdtemp(join(tmpdir(), "digithive-chat-qa-"));
  const browserPath = process.env["QA_CHROME_PATH"] ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
  const browser = await omowright.connectPipe({
    browserPath,
    browserArgs: ["--headless=new", "--no-first-run", `--user-data-dir=${profile}`],
    storageRoot: profile,
    dialogPolicy: { accept: true },
  }) as Browser;
  const page = await browser.newTab("about:blank") as Page;
  return {
    page,
    browser,
    omowright,
    async close() {
      await browser.close();
      await rm(profile, { recursive: true, force: true });
    },
  };
}

function textOf(page: Page, testId: string): Promise<string> {
  return page.evaluate((id) => {
    const node = document.querySelector(`[data-testid="${id}"]`);
    return node?.textContent ?? "";
  }, testId);
}

async function waitForText(page: Page, testId: string, needle: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await textOf(page, testId)).includes(needle)) return true;
    await Bun.sleep(250);
  }
  return false;
}

async function login(page: Page, context: BrowserContext): Promise<void> {
  await page.goto(context.base);
  await page.locator('[data-testid="passphrase"]').fill(context.passphrase);
  await page.locator('[data-testid="login"]').click();
  await page.goto(`${context.base}/`);
}

export async function chatBrowser(context: BrowserContext): Promise<void> {
  const { page, omowright, close } = await connect();
  const steps: string[] = [];
  try {
    await login(page, context);
    steps.push("logged in and opened the conversation view");
    await page.locator('[data-testid="chat-input"]').fill("이 단어의 어원을 설명해줘");
    await page.locator('[data-testid="chat-send"]').click();
    steps.push("sent a message from the composer");
    assert.equal(await waitForText(page, "messages", "fixture answer"), true, "assistant answer never arrived");
    steps.push("assistant answer appeared");

    await page.goto(`${context.base}/`);
    const restored = await textOf(page, "messages");
    assert.equal(restored.includes("이 단어의 어원을 설명해줘"), true);
    assert.equal((restored.match(/fixture answer/g) ?? []).length, 1);
    steps.push("reload restored the question and exactly one answer");
    await writeFile(join(context.evidence, "desktop.png"), await page.screenshot());

    await page.goto(`${context.base}/`);
    await omowright.emulate(page, "iphone-14");
    const layout = await page.evaluate(() => ({ inner: globalThis.innerWidth, scroll: document.documentElement.scrollWidth }), "messages");
    assert.equal(layout.inner, 390, `emulated width was ${layout.inner}`);
    assert.equal(layout.scroll, 390);
    const mobileText = await textOf(page, "messages");
    assert.equal((mobileText.match(/fixture answer/g) ?? []).length, 1);
    await writeFile(join(context.evidence, "mobile.png"), await page.screenshot());
    steps.push("mobile 390px kept the conversation with zero horizontal overflow");

    await writeFile(join(context.evidence, "actions.json"), `${JSON.stringify({
      steps, answers: 1, restoredAfterReload: true, mobileWidth: layout.inner, documentWidth: layout.scroll,
    }, null, 2)}\n`);
  } finally {
    await close();
  }
}

export async function chatOfflineCancel(context: BrowserContext & { readonly startWorker: () => Promise<void> }): Promise<void> {
  const { page, close } = await connect();
  const steps: string[] = [];
  try {
    await login(page, context);
    await page.locator('[data-testid="chat-input"]').fill("취소할 작업을 시작해줘");
    await page.locator('[data-testid="chat-send"]').click();
    steps.push("queued a message while no worker was running");
    const appeared = await waitForText(page, "messages", "취소할 작업을 시작해줘", 10_000);
    await writeFile(join(context.evidence, "debug-send.json"), `${JSON.stringify({
      appeared, messages: await textOf(page, "messages"), status: await textOf(page, "run-status"),
    }, null, 2)}\n`);
    assert.equal(appeared, true, "user bubble never appeared");
    await page.goto(`${context.base}/`);
    const queued = await waitForText(page, "run-status", "작업 대기 중", 10_000);
    await writeFile(join(context.evidence, "debug-reload.json"), `${JSON.stringify({
      queued, messages: await textOf(page, "messages"), status: await textOf(page, "run-status"),
    }, null, 2)}\n`);
    assert.equal(queued, true);
    steps.push("reload showed the queued task truthfully instead of an answer");
    await page.locator('[data-testid="run-cancel"]').click();
    assert.equal(await waitForText(page, "run-status", "취소", 20_000), true);
    steps.push("cancel from the UI reached a terminal state");
    const messages = await textOf(page, "messages");
    assert.equal((messages.match(/취소할 작업을 시작해줘/g) ?? []).length, 1);
    assert.equal(messages.includes("fixture answer"), false);
    await context.startWorker();
    await Bun.sleep(2_500);
    const status = await textOf(page, "run-status");
    assert.equal(status.includes("작업 대기 중"), false);
    assert.equal((await textOf(page, "messages")).includes("fixture answer"), false);
    steps.push("a worker started after cancellation produced no answer and no duplicate bubble");
    await writeFile(join(context.evidence, "mobile-error.png"), await page.screenshot());
    await writeFile(join(context.evidence, "actions.json"), `${JSON.stringify({
      steps, duplicateBubbles: 0, terminalState: "cancelled", lateWorkerAnswer: false,
    }, null, 2)}\n`);
  } finally {
    await close();
  }
}
