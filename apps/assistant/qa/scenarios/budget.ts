import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { BudgetError, monthBucket, reserve, settle, usage } from "../../src/runtime/budget";
import { enqueue } from "../../src/runtime/queue";

type BudgetContext = {
  readonly db: Database;
  readonly dbPath: string;
  readonly evidence: string;
  readonly base: string;
  readonly cookie: string;
};

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const reader = stream.getReader();
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return text + decoder.decode();
    text += decoder.decode(chunk.value, { stream: true });
  }
}

const MONTH = "2026-11";

export async function budgetSettle(context: BudgetContext): Promise<void> {
  const run = enqueue(context.db, { requestKey: "budget-settle", goal: "two calls", executor: "sha256" }, 1000);
  const first = reserve(context.db, {
    runId: run.id, providerRequestId: "call-one", bucket: MONTH, priceVersion: "price-v1",
    estimateMicroUsd: 200_000, limitMicroUsd: 100_000_000,
  }, 1001);
  const second = reserve(context.db, {
    runId: run.id, providerRequestId: "call-two", bucket: MONTH, priceVersion: "price-v1",
    estimateMicroUsd: 200_000, limitMicroUsd: 100_000_000,
  }, 1002);
  settle(context.db, first.id, 150_000, 1003);
  settle(context.db, second.id, 250_000, 1004);

  const response = await fetch(`${context.base}/api/usage`, { headers: { cookie: context.cookie } });
  assert.equal(response.status, 200);
  const body = z.object({
    monthBucket: z.string(),
    settledMicroUsd: z.number(),
    reservedMicroUsd: z.number(),
    unknownMicroUsd: z.number(),
    limitMicroUsd: z.number(),
    priceVersions: z.array(z.string().nullable()),
    proposals: z.object({ noticeMicroUsd: z.number(), reduceMicroUsd: z.number(), pauseMicroUsd: z.number() }),
  }).parse(await response.json());
  assert.equal(body.settledMicroUsd, 400_000);
  assert.equal(body.reservedMicroUsd, 0);
  assert.equal(body.unknownMicroUsd, 0);
  assert.deepEqual(body.priceVersions, ["price-v1"]);
  assert.equal(body.proposals.pauseMicroUsd, 100_000_000);
  await writeFile(join(context.evidence, "usage.json"), `${JSON.stringify(body, null, 2)}\n`);
}

export async function budgetConcurrentUnknown(context: BudgetContext): Promise<void> {
  const run = enqueue(context.db, { requestKey: "budget-race", goal: "race", executor: "sha256" }, 1000);
  const limit = 100_000_000;
  reserve(context.db, {
    runId: run.id, providerRequestId: "prior-spend", bucket: MONTH, priceVersion: "price-v1",
    estimateMicroUsd: 99_900_000, limitMicroUsd: limit,
  }, 1001);

  const child = `import {openDatabase} from "./src/db/store.ts";
import {reserve} from "./src/runtime/budget.ts";
const db = openDatabase(process.env.ASSISTANT_DB_PATH);
try {
  const r = reserve(db, { runId: process.env.QA_RUN, providerRequestId: process.env.QA_REQUEST,
    bucket: "2026-11", priceVersion: "price-v1", estimateMicroUsd: 100000, limitMicroUsd: 100000000 }, 1002);
  console.log(JSON.stringify({ ok: true, id: r.id }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, kind: error instanceof Error ? error.message : "unknown" }));
} finally { db.close(); }`;
  const processes = ["race-a", "race-b"].map((requestId) => Bun.spawn(
    [process.execPath, "-e", child],
    {
      env: { ...process.env, ASSISTANT_DB_PATH: context.dbPath, QA_RUN: run.id, QA_REQUEST: requestId },
      stdout: "pipe", stderr: "pipe",
    },
  ));
  const deadline = setTimeout(() => { for (const childProcess of processes) childProcess.kill(); }, 20_000);
  const outputs = await Promise.all(processes.map(async (childProcess) => {
    assert.ok(childProcess.stdout);
    const text = await readAll(childProcess.stdout);
    const exitCode = await childProcess.exited;
    assert.equal(exitCode, 0);
    return z.object({ ok: z.boolean(), id: z.string().optional(), kind: z.string().optional() }).parse(JSON.parse(text));
  }));
  clearTimeout(deadline);
  const accepted = outputs.filter((outcome) => outcome.ok);
  const rejected = outputs.filter((outcome) => !outcome.ok);
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]?.kind, "limit_exceeded");

  const reservation = accepted[0];
  assert.ok(reservation?.id);
  settle(context.db, reservation.id, null, 1003);

  const view = usage(context.db, MONTH, limit);
  assert.equal(view.settledMicroUsd, 0);
  assert.equal(view.unknownMicroUsd, 100_000);
  assert.equal(view.committedMicroUsd, 100_000_000);

  const boundary = monthBucket(Date.parse("2026-10-31T16:00:00Z"), "Asia/Seoul");
  assert.equal(boundary, "2026-11");
  const otherMonth = usage(context.db, "2026-12", limit);
  assert.equal(otherMonth.committedMicroUsd, 0);

  await writeFile(join(context.evidence, "ledger.json"), `${JSON.stringify({
    processes: outputs.length,
    accepted: accepted.length,
    refused: rejected.length,
    winner: reservation.id,
    usage: view,
    boundary,
    nextMonthCommitted: otherMonth.committedMicroUsd,
  }, null, 2)}\n`);
}
