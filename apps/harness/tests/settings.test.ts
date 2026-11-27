import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createHarness, loadConfig } from "../src/server/main";
import { openDatabase } from "../src/store/db";
import { LATEST } from "../src/store/migrations";
import {
  ensureSettingsTable,
  isModelPriority,
  MODEL_PRIORITY_KEY,
  modelRouteCatalog,
  normalizeModelPriority,
  readModelPriority,
  writeModelPriority,
  type ModelRouteSummary,
} from "../src/providers/settings";
import { ProviderStore } from "../src/providers/store";

const routes: ModelRouteSummary[] = [
  { name: "primary", model: "primary-model", baseUrl: "http://primary/v1" },
  { name: "backup", model: "backup-model", baseUrl: "http://backup/v1" },
];

function setup() {
  const root = mkdtempSync(join(tmpdir(), "settings-"));
  const dbPath = join(root, "harness.db");
  const harness = createHarness(
    loadConfig({
      HARNESS_DB: dbPath,
      HARNESS_WORKSPACE: join(root, "workspace"),
      HARNESS_SESSION_SECRET: "test-secret",
      MODEL_BASE_URL: "https://primary.example/v1",
      MODEL_API_KEY: "primary-secret-key",
      MODEL_NAME: "primary-model",
      MODEL_FALLBACKS_JSON: JSON.stringify([
        {
          name: "backup",
          baseUrl: "https://backup.example/v1",
          apiKey: "fallback-secret-key",
          model: "backup-model",
        },
      ]),
    }),
  );
  return {
    harness,
    dbPath,
    cleanup: () => {
      harness.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("the settings store is additive and does not move the schema version", () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA user_version = 15");
  ensureSettingsTable(db);
  expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()).toEqual({
    user_version: 15,
  });
  expect(
    db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all(),
  ).toContainEqual({ name: "settings" });
  db.close();
});

test("a saved order survives a new connection and a changed fallback list", () => {
  const db = new Database(":memory:");
  ensureSettingsTable(db);
  writeModelPriority(db, ["backup", "primary"], routes);

  // The same database opened again by the worker sees the owner's order.
  expect(readModelPriority(db, routes)).toEqual(["backup", "primary"]);

  // A removed route is dropped and a newly configured route is appended, so the
  // order is always complete even when the environment changed since the save.
  expect(
    normalizeModelPriority(
      ["gone", "backup", "primary"],
      [...routes, { name: "third", model: "third-model", baseUrl: "http://third/v1" }],
    ),
  ).toEqual(["backup", "primary", "third"]);
  expect(
    readModelPriority(
      db,
      routes.filter((route) => route.name === "primary"),
    ),
  ).toEqual(["primary"]);
  db.close();
});

test("only an exact permutation of configured names is accepted", () => {
  expect(isModelPriority(["backup", "primary"], routes)).toBe(true);
  expect(isModelPriority(["primary"], routes)).toBe(false);
  expect(isModelPriority(["backup", "backup"], routes)).toBe(false);
  expect(isModelPriority(["backup", "primary", "extra"], routes)).toBe(false);
  expect(isModelPriority(["backup", "unknown"], routes)).toBe(false);
});

test("read and write require the store the runtime creates", () => {
  const db = new Database(":memory:");
  expect(() => readModelPriority(db, routes)).toThrow(/settings/);
  expect(() => writeModelPriority(db, ["primary", "backup"], routes)).toThrow(/settings/);
  db.close();
});

test("a malformed saved value falls back to config order, but a database error surfaces", () => {
  const db = new Database(":memory:");
  ensureSettingsTable(db);
  db.query("INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, 'now')").run(
    MODEL_PRIORITY_KEY,
    "{not json",
  );
  expect(readModelPriority(db, routes)).toEqual(["primary", "backup"]);

  db.query("UPDATE settings SET value_json = ? WHERE key = ?").run(
    JSON.stringify(["backup", 1]),
    MODEL_PRIORITY_KEY,
  );
  expect(readModelPriority(db, routes)).toEqual(["primary", "backup"]);

  db.close();
  expect(() => readModelPriority(db, routes)).toThrow();
});

test("loadConfig refuses duplicate fallback names and the reserved primary name", () => {
  const fallback = (name: string) => ({
    name,
    baseUrl: `https://${name}.example/v1`,
    apiKey: "k",
    model: `${name}-model`,
  });
  expect(() =>
    loadConfig({
      MODEL_FALLBACKS_JSON: JSON.stringify([fallback("backup"), fallback("backup")]),
    }),
  ).toThrow(/duplicate route name "backup"/);
  expect(() => loadConfig({ MODEL_FALLBACKS_JSON: JSON.stringify([fallback("primary")]) })).toThrow(
    /reserved for MODEL_BASE_URL/,
  );
  expect(
    loadConfig({
      MODEL_FALLBACKS_JSON: JSON.stringify([fallback("backup"), fallback("third")]),
    }).fallbackProviders.map((route) => route.name),
  ).toEqual(["backup", "third"]);
});

test("GET exposes the routing chain without leaking a provider key", async () => {
  const { harness, dbPath, cleanup } = setup();
  const bodySchema = z.object({
    chain: z.array(
      z.object({
        providerId: z.string(),
        modelId: z.string(),
        position: z.number(),
        enabled: z.boolean(),
      }),
    ),
    routes: z.array(z.object({ name: z.string(), modelId: z.string(), baseUrl: z.string() })),
  });
  try {
    const read = () => harness.handler(new Request("http://local/api/settings/models"));
    const initial = await read();
    expect(initial.status).toBe(200);
    const initialBody = bodySchema.parse(await initial.json());
    // The environment's model configuration became the first chain on a database that had
    // no provider yet: primary first, then the configured fallback.
    expect(initialBody.chain.map((entry) => entry.modelId)).toEqual([
      "primary-model",
      "backup-model",
    ]);
    expect(initialBody.routes.map((route) => route.modelId)).toEqual([
      "primary-model",
      "backup-model",
    ]);
    const rawBody = JSON.stringify(initialBody);
    expect(rawBody).not.toContain("primary-secret-key");
    expect(rawBody).not.toContain("fallback-secret-key");
    expect(rawBody).not.toContain("apiKey");

    const [first, second] = initialBody.chain;
    const saved = await harness.handler(
      new Request("http://local/api/settings/models", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          entries: [
            { providerId: second?.providerId, modelId: second?.modelId },
            { providerId: first?.providerId, modelId: first?.modelId },
          ],
        }),
      }),
    );
    expect(saved.status).toBe(200);
    expect(bodySchema.parse(await saved.json()).chain.map((entry) => entry.modelId)).toEqual([
      "backup-model",
      "primary-model",
    ]);

    const after = await read();
    expect(bodySchema.parse(await after.json()).routes.map((route) => route.modelId)).toEqual([
      "backup-model",
      "primary-model",
    ]);

    // The handler's own catalogue is the same public shape the chain yields.
    expect(modelRouteCatalog(loadConfig({ MODEL_BASE_URL: "u", MODEL_NAME: "m" }))).toEqual([
      { name: "primary", model: "m", baseUrl: "u" },
    ]);

    // The worker opens a separate connection to the same file; it sees the saved chain.
    const reopened = openDatabase(dbPath);
    try {
      const store = new ProviderStore(reopened, "test-secret");
      expect(store.routes().map((entry) => entry.modelId)).toEqual([
        "backup-model",
        "primary-model",
      ]);
      expect(reopened.query<{ user_version: number }, []>("PRAGMA user_version").get()).toEqual({
        user_version: LATEST,
      });
    } finally {
      reopened.close();
    }
  } finally {
    cleanup();
  }
});

test("PUT refuses a partial, duplicated, unknown or malformed chain", async () => {
  const { harness, cleanup } = setup();
  try {
    const read = await harness.handler(new Request("http://local/api/settings/models"));
    const chain = z
      .object({ chain: z.array(z.object({ providerId: z.string(), modelId: z.string() })) })
      .parse(await read.json()).chain;
    const [first, second] = chain;
    for (const body of [
      { entries: [{ providerId: first?.providerId, modelId: first?.modelId }] },
      {
        entries: [
          { providerId: first?.providerId, modelId: first?.modelId },
          { providerId: first?.providerId, modelId: first?.modelId },
        ],
      },
      {
        entries: [
          { providerId: second?.providerId, modelId: second?.modelId },
          { providerId: "nope", modelId: "nope" },
        ],
      },
      { entries: ["primary", "backup"] },
      { priority: ["primary", "backup"] },
    ]) {
      const response = await harness.handler(
        new Request("http://local/api/settings/models", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      expect(response.status).toBe(422);
    }
  } finally {
    cleanup();
  }
});
