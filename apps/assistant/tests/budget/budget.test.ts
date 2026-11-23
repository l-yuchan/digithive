import assert from "node:assert/strict";
import { afterEach, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/db/store";
import { BudgetError, monthBucket, reserve, settle, usage } from "../../src/runtime/budget";
import { enqueue } from "../../src/runtime/queue";

const databases: Database[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

function shared(): { first: Database; second: Database } {
  const directory = mkdtempSync(join(tmpdir(), "digithive-budget-"));
  directories.push(directory);
  const filename = join(directory, "shared.sqlite");
  const first = openDatabase(filename);
  const second = openDatabase(filename);
  databases.push(first, second);
  return { first, second };
}

function runId(db: Database, key: string): string {
  return enqueue(db, { requestKey: key, goal: "budget", executor: "sha256" }).id;
}

test("the second concurrent reservation cannot pass the monthly limit", () => {
  const { first, second } = shared();
  const run = runId(first, "budget-limit");
  const limit = 100_000_000;
  reserve(first, {
    runId: run, providerRequestId: "prior", bucket: "2026-11", priceVersion: "price-1",
    estimateMicroUsd: 99_900_000, limitMicroUsd: limit,
  }, 1000);

  const accepted = reserve(first, {
    runId: run, providerRequestId: "request-a", bucket: "2026-11", priceVersion: "price-1",
    estimateMicroUsd: 100_000, limitMicroUsd: limit,
  }, 1001);
  assert.equal(accepted.status, "active");

  assert.throws(() => reserve(second, {
    runId: run, providerRequestId: "request-b", bucket: "2026-11", priceVersion: "price-1",
    estimateMicroUsd: 100_000, limitMicroUsd: limit,
  }, 1002), BudgetError);
  assert.equal(usage(second, "2026-11", limit).committedMicroUsd, 100_000_000);
});

test("missing usage becomes an unknown liability instead of free cost", () => {
  const { first } = shared();
  const run = runId(first, "budget-unknown");
  const reservation = reserve(first, {
    runId: run, providerRequestId: "request-missing", bucket: "2026-11", priceVersion: "price-1",
    estimateMicroUsd: 500_000, limitMicroUsd: 100_000_000,
  }, 1000);

  const settled = settle(first, reservation.id, null, 2000);
  assert.equal(settled.status, "unknown");
  assert.equal(settled.settled_micro_usd, null);
  const view = usage(first, "2026-11", 100_000_000);
  assert.equal(view.settledMicroUsd, 0);
  assert.equal(view.unknownMicroUsd, 500_000);
  assert.equal(view.committedMicroUsd, 500_000);
  assert.throws(() => settle(first, reservation.id, 1, 3000), BudgetError);
});

test("an unpriced provider call is blocked before any reservation exists", () => {
  const { first } = shared();
  const run = runId(first, "budget-price");
  assert.throws(() => reserve(first, {
    runId: run, providerRequestId: "no-price", bucket: "2026-11", priceVersion: null,
    estimateMicroUsd: 1, limitMicroUsd: 100_000_000,
  }, 1000), BudgetError);
  assert.equal(usage(first, "2026-11", 100_000_000).committedMicroUsd, 0);
});

test("the month bucket follows the configured timezone, not UTC", () => {
  const instant = Date.parse("2026-10-31T16:00:00Z");
  assert.equal(monthBucket(instant, "Asia/Seoul"), "2026-11");
  assert.equal(monthBucket(instant, "UTC"), "2026-10");
});

test("repeating a provider request id returns the original reservation", () => {
  const { first } = shared();
  const run = runId(first, "budget-idempotent");
  const input = {
    runId: run, providerRequestId: "same-request", bucket: "2026-11", priceVersion: "price-1",
    estimateMicroUsd: 10, limitMicroUsd: 100_000_000,
  } as const;
  assert.equal(reserve(first, input, 1000).id, reserve(first, input, 1001).id);
  assert.equal(usage(first, "2026-11", 100_000_000).reservedMicroUsd, 10);
});
