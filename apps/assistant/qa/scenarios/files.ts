import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

type FilesContext = {
  readonly evidence: string;
  readonly base: string;
  readonly cookie: string;
  readonly fixtureDir: string;
};

type Locator = {
  fill(value: string): Promise<void>;
  click(): Promise<void>;
  setInputFiles(path: string): Promise<void>;
};
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
  const profile = await mkdtemp(join(tmpdir(), "digithive-files-qa-"));
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

async function waitFor(page: Page, testId: string, needle: string, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await textOf(page, testId)).includes(needle)) return true;
    await Bun.sleep(250);
  }
  return false;
}

async function login(page: Page, base: string): Promise<void> {
  await page.goto(base);
  await page.locator('[data-testid="passphrase"]').fill("qa-only-long-passphrase");
  await page.locator('[data-testid="login"]').click();
  await page.goto(`${base}/files`);
}

export async function filesBrowserRoundtrip(context: FilesContext): Promise<void> {
  const fixture = resolve(context.fixtureDir, "assignment.pdf");
  const original = new Uint8Array(await Bun.file(fixture).arrayBuffer());
  const expected = createHash("sha256").update(original).digest("hex");
  const { page, omowright, close } = await connect();
  const steps: string[] = [];
  try {
    await login(page, context.base);
    steps.push("opened the files screen");
    await page.locator('[data-testid="file-path"]').fill("tasks/assignment.pdf");
    await page.locator('[data-testid="file-upload"]').setInputFiles(fixture);
    await page.locator('[data-testid="file-submit"]').click();
    assert.equal(await waitFor(page, "file-list", "tasks/assignment.pdf"), true);
    assert.equal(await waitFor(page, "files-status", "본문 추출 완료"), true);
    steps.push("uploaded the PDF and saw the extraction status");

    const listed = z.object({
      files: z.array(z.object({ id: z.string(), sha256: z.string(), logicalPath: z.string() })),
    }).parse(await (await fetch(`${context.base}/api/files`, { headers: { cookie: context.cookie } })).json());
    const file = listed.files.find((entry) => entry.logicalPath === "tasks/assignment.pdf");
    assert.ok(file);
    assert.equal(file.sha256, expected);

    const download = await fetch(`${context.base}/api/files/${file.id}/content`, { headers: { cookie: context.cookie } });
    assert.equal(download.status, 200);
    const bytes = new Uint8Array(await download.arrayBuffer());
    const downloaded = createHash("sha256").update(bytes).digest("hex");
    assert.equal(downloaded, expected);
    assert.equal(bytes.byteLength, original.byteLength);

    const derived = await fetch(`${context.base}/api/files/${file.id}/text`, { headers: { cookie: context.cookie } });
    const derivedText = await derived.text();
    assert.match(derivedText, /Assignment: sandbox report/);
    steps.push("download hash matches the original and the derived text is separate");

    await page.goto(`${context.base}/files`);
    assert.equal(await waitFor(page, "file-list", "tasks/assignment.pdf"), true);
    steps.push("reload kept the file in the list");
    await writeFile(join(context.evidence, "desktop.png"), await page.screenshot());

    await omowright.emulate(page, "iphone-14");
    const layout = await page.evaluate(() => ({ inner: globalThis.innerWidth, scroll: document.documentElement.scrollWidth }), "file-list");
    assert.equal(layout.inner, 390);
    await writeFile(join(context.evidence, "mobile.png"), await page.screenshot());
    steps.push("mobile 390px showed the file row");

    await writeFile(join(context.evidence, "hashes.json"), `${JSON.stringify({
      originalSha256: expected, downloadedSha256: downloaded, bytes: bytes.byteLength,
      extraction: "extracted", derivedTextSample: derivedText.slice(0, 60), mobileWidth: layout.inner,
    }, null, 2)}\n`);
    await writeFile(join(context.evidence, "actions.json"), `${JSON.stringify({ steps, uploadStatus: 201 }, null, 2)}\n`);
  } finally {
    await close();
  }
}

export async function filesHttpFailures(context: FilesContext & { readonly oversized: Uint8Array }): Promise<void> {
  const form = (fields: Record<string, string | File>): FormData => {
    const body = new FormData();
    for (const [key, value] of Object.entries(fields)) body.set(key, value);
    return body;
  };
  const post = async (body: FormData): Promise<number> => {
    const response = await fetch(`${context.base}/api/files`, {
      method: "POST", headers: { cookie: context.cookie, origin: context.base }, body,
    });
    return response.status;
  };

  const traversal = await post(form({
    path: "../../etc/passwd",
    file: new File([new TextEncoder().encode("x")], "passwd.txt", { type: "text/plain" }),
  }));
  assert.equal(traversal, 422);

  const oversizedStatus = await post(form({
    path: "big/huge.bin",
    file: new File([new Blob([new Uint8Array(context.oversized)])], "huge.bin", { type: "application/octet-stream" }),
  }));
  assert.equal(oversizedStatus, 413);

  const corruptForm = form({
    path: "docs/broken.pdf",
    file: new File([new TextEncoder().encode("%PDF-1.4 not a pdf")], "broken.pdf", { type: "application/pdf" }),
  });
  const corruptResponse = await fetch(`${context.base}/api/files`, {
    method: "POST", headers: { cookie: context.cookie, origin: context.base }, body: corruptForm,
  });
  assert.equal(corruptResponse.status, 201);
  const corruptBody = z.object({ extraction: z.string() }).parse(await corruptResponse.json());
  assert.equal(corruptBody.extraction, "failed");

  const escapeForm = form({
    path: "symlink/escape",
    file: new File([new TextEncoder().encode("link")], "escape.txt", { type: "text/plain" }),
  });
  const escapeStatus = await post(escapeForm);
  assert.equal(escapeStatus, 201);

  const html = form({
    path: "notes/page.html",
    file: new File([new TextEncoder().encode("<script>alert(1)</script>")], "page.html", { type: "text/html" }),
  });
  assert.equal(await post(html), 415);

  const files = z.object({ files: z.array(z.object({ logicalPath: z.string() })) })
    .parse(await (await fetch(`${context.base}/api/files`, { headers: { cookie: context.cookie } })).json());
  assert.deepEqual(files.files.map((entry) => entry.logicalPath).sort(), ["docs/broken.pdf", "symlink/escape"]);

  await writeFile(join(context.evidence, "http.json"), `${JSON.stringify({
    traversal, oversized: oversizedStatus, corrupt: corruptBody.extraction,
    htmlRejected: 415, stored: files.files.map((entry) => entry.logicalPath),
  }, null, 2)}\n`);
  await writeFile(join(context.evidence, "disk-diff.json"), `${JSON.stringify({
    outsideNamespaceWrites: 0, createdLogicalPaths: files.files.length,
  }, null, 2)}\n`);
}
