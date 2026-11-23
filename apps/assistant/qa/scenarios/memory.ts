import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { addMemory, contextEpoch, deleteMemory } from "../../src/knowledge/memory";
import { search } from "../../src/knowledge/retrieval";
import { toCitations } from "../../src/knowledge/citations";
import { createRegistry } from "../../src/agents/tools";
import { enqueue } from "../../src/runtime/queue";
import { runAgent } from "../../src/runtime/executors/agent";
import { setProviderScript } from "./provider";

type MemoryContext = {
  readonly db: Database;
  readonly evidence: string;
  readonly base: string;
  readonly cookie: string;
};

type Locator = { fill(value: string): Promise<void>; click(): Promise<void>; selectOption(value: string): Promise<void> };
type Page = {
  goto(url: string): Promise<unknown>;
  locator(selector: string): Locator;
  screenshot(): Promise<Uint8Array>;
  evaluate<T>(fn: (testId: string) => T, testId: string): Promise<T>;
};
type Browser = { newTab(url: string): Promise<unknown>; close(): Promise<void> };
type Omowright = { connectPipe(options: Record<string, unknown>): Promise<unknown>; emulate(page: unknown, preset: string): Promise<unknown> };

function modulePath(): string {
  const configured = process.env["OMOWRIGHT_MODULE"];
  if (!configured) throw new Error("OMOWRIGHT_MODULE must point at the browser skill's omowright.mjs");
  return configured;
}

async function connect(): Promise<{ page: Page; omowright: Omowright; close(): Promise<void> }> {
  const module = await import(modulePath()) as { loadOmowright(): Promise<{ omowright: Omowright }> };
  const { omowright } = await module.loadOmowright();
  const profile = await mkdtemp(join(tmpdir(), "digithive-memory-qa-"));
  const browser = await omowright.connectPipe({
    browserPath: process.env["QA_CHROME_PATH"] ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
    browserArgs: ["--headless=new", "--no-first-run", `--user-data-dir=${profile}`],
    storageRoot: profile,
    dialogPolicy: { accept: true },
  }) as Browser;
  const page = await browser.newTab("about:blank") as Page;
  return {
    page,
    omowright,
    async close() {
      await browser.close();
      await rm(profile, { recursive: true, force: true });
    },
  };
}

function textOf(page: Page, testId: string): Promise<string> {
  return page.evaluate((id) => document.querySelector(`[data-testid="${id}"]`)?.textContent ?? "", testId);
}

async function waitFor(page: Page, testId: string, needle: string, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await textOf(page, testId)).includes(needle)) return true;
    await Bun.sleep(250);
  }
  return false;
}

export async function memoryCorrectBrowser(context: MemoryContext): Promise<void> {
  const { page, omowright, close } = await connect();
  const steps: string[] = [];
  try {
    await page.goto(context.base);
    await page.locator('[data-testid="passphrase"]').fill("qa-only-long-passphrase");
    await page.locator('[data-testid="login"]').click();
    await page.goto(`${context.base}/memory`);
    steps.push("opened the memory screen");

    await page.locator('[data-testid="memory-statement"]').fill("아침에는 길게 설명해줘");
    await page.locator('[data-testid="memory-kind"]').selectOption("preference");
    await page.locator('[data-testid="memory-evidence"]').fill("conversation:qa-1");
    await page.locator('[data-testid="memory-save"]').click();
    assert.equal(await waitFor(page, "memory-list", "아침에는 길게 설명해줘"), true);
    assert.equal(await waitFor(page, "memory-list", "rev 1"), true);
    steps.push("added a preference memory (rev 1)");

    await page.locator('[data-testid="memory-edit"]').click();
    await page.locator('[data-testid="memory-correction"]').fill("아침에는 짧게 설명해줘");
    await page.locator('[data-testid="memory-apply"]').click();
    assert.equal(await waitFor(page, "memory-status", "수정했습니다"), true);
    assert.equal(await waitFor(page, "memory-list", "아침에는 짧게 설명해줘"), true);
    assert.equal(await waitFor(page, "memory-list", "rev 2"), true);
    steps.push("corrected the memory to rev 2");

    const searchResponse = await fetch(`${context.base}/api/memories/search`, {
      method: "POST",
      headers: { cookie: context.cookie, origin: context.base, "content-type": "application/json" },
      body: JSON.stringify({ query: "짧게" }),
    });
    assert.equal(searchResponse.status, 200);
    const found = z.object({
      citations: z.array(z.object({ sourceId: z.string(), revision: z.number(), quote: z.string() })),
    }).parse(await searchResponse.json());
    assert.equal(found.citations.length, 1);
    assert.equal(found.citations[0]?.revision, 2);
    assert.equal(found.citations[0]?.quote, "아침에는 짧게 설명해줘");
    const oldWording = await fetch(`${context.base}/api/memories/search`, {
      method: "POST",
      headers: { cookie: context.cookie, origin: context.base, "content-type": "application/json" },
      body: JSON.stringify({ query: "길게" }),
    });
    const oldResult = z.object({ citations: z.array(z.unknown()) }).parse(await oldWording.json());
    assert.equal(oldResult.citations.length, 0);
    steps.push("retrieval cites rev 2 and the corrected-away wording is gone");

    await writeFile(join(context.evidence, "memory-diff.json"), `${JSON.stringify({
      original: { statement: "아침에는 길게 설명해줘", revision: 1 },
      corrected: { statement: "아침에는 짧게 설명해줘", revision: 2 },
      searchCitationRevision: found.citations[0]?.revision,
      oldWordingMatches: oldResult.citations.length,
    }, null, 2)}\n`);
    await writeFile(join(context.evidence, "actions.json"), `${JSON.stringify({ steps }, null, 2)}\n`);
    await writeFile(join(context.evidence, "desktop.png"), await page.screenshot());
    await omowright.emulate(page, "iphone-14");
    await writeFile(join(context.evidence, "mobile.png"), await page.screenshot());
  } finally {
    await close();
  }
}

const pricing = { version: "fixture-v1", inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 2 };

export async function memoryRevokeInflight(context: MemoryContext): Promise<void> {
  const memory = addMemory(context.db, {
    statement: "회의는 항상 화요일 오후 3시", kind: "fact", evidenceRef: "mail:qa",
  }, Date.now());
  const run = enqueue(context.db, { requestKey: "memory-inflight", goal: "회의 시간 알려줘", executor: "agent" });

  setProviderScript([{
    delayMs: 1_200,
    body: {
      choices: [{ message: { role: "assistant", content: "회의는 화요일 오후 3시입니다." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 80, completion_tokens: 12 },
    },
  }]);

  const epochBefore = contextEpoch(context.db);
  const pending = runAgent(context.db, {
    baseUrl: `${context.base.replace("4317", "4318")}/v1`, model: "fixture-model", apiKey: "fixture-key", pricing,
  }, createRegistry([]), {
    runId: run.id, goal: "회의 시간 알려줘", scopes: [],
    limitMicroUsd: 100_000_000, timeZone: "Asia/Seoul",
    epoch: () => contextEpoch(context.db),
  });
  await Bun.sleep(300);
  const deleted = deleteMemory(context.db, memory.id, { revision: memory.revision }, Date.now());
  const outcome = await pending;

  assert.equal(deleted.deleted, true);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.reason, "context_changed");
  assert.equal(contextEpoch(context.db) > epochBefore, true);
  assert.deepEqual(search(context.db, { query: "화요일" }), []);
  assert.deepEqual(toCitations(search(context.db, { query: "화요일" })), []);

  setProviderScript([]);
  await writeFile(join(context.evidence, "events.json"), `${JSON.stringify({
    runStatus: outcome.status, reason: outcome.reason,
    epochBefore, epochAfter: contextEpoch(context.db), publishedAnswer: outcome.output,
  }, null, 2)}\n`);
  await writeFile(join(context.evidence, "retrieval.json"), `${JSON.stringify({
    query: "화요일", matches: search(context.db, { query: "화요일" }).length, citations: 0,
  }, null, 2)}\n`);

  const staleEdit = await fetch(`${context.base}/api/memories/${memory.id}`, {
    method: "PATCH",
    headers: { cookie: context.cookie, origin: context.base, "content-type": "application/json" },
    body: JSON.stringify({ revision: memory.revision, correction: "회의는 수요일" }),
  });
  assert.equal(staleEdit.status, 409);
}
