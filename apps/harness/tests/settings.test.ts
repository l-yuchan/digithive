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

test("GET and PUT expose an ordered priority without leaking route credentials", async () => {
  const { harness, dbPath, cleanup } = setup();
  const bodySchema = z.object({
    routes: z.array(z.object({ name: z.string(), model: z.string(), baseUrl: z.string() })),
    priority: z.array(z.string()),
  });
  try {
    const read = () => harness.handler(new Request("http://local/api/settings/models"));
    const initial = await read();
    expect(initial.status).toBe(200);
    const initialBody = bodySchema.parse(await initial.json());
    expect(initialBody).toEqual({
      routes: [
        { name: "primary", model: "primary-model", baseUrl: "https://primary.example/v1" },
        { name: "backup", model: "backup-model", baseUrl: "https://backup.example/v1" },
      ],
      priority: ["primary", "backup"],
    });
    const rawBody = JSON.stringify(initialBody);
    expect(rawBody).not.toContain("primary-secret-key");
    expect(rawBody).not.toContain("fallback-secret-key");
    expect(rawBody).not.toContain("apiKey");

    const saved = await harness.handler(
      new Request("http://local/api/settings/models", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ priority: ["backup", "primary"] }),
      }),
    );
    expect(saved.status).toBe(200);
    expect(bodySchema.parse(await saved.json())).toEqual({
      routes: initialBody.routes,
      priority: ["backup", "primary"],
    });

    const after = await read();
    expect(bodySchema.parse(await after.json()).priority).toEqual(["backup", "primary"]);

    // The handler's own catalogue is the same public shape the config yields.
    expect(modelRouteCatalog(loadConfig({ MODEL_BASE_URL: "u", MODEL_NAME: "m" }))).toEqual([
      { name: "primary", model: "m", baseUrl: "u" },
    ]);

    // The worker opens a separate connection to the same file; it sees the saved order.
    const reopened = openDatabase(dbPath);
    try {
      expect(readModelPriority(reopened, routes)).toEqual(["backup", "primary"]);
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

test("PUT refuses a partial, duplicated, unknown or malformed priority", async () => {
  const { harness, cleanup } = setup();
  try {
    for (const body of [
      { priority: ["backup"] },
      { priority: ["backup", "backup"] },
      { priority: ["backup", "nope"] },
      { priority: "backup" },
      {},
    ]) {
      const response = await harness.handler(
        new Request("http://local/api/settings/models", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: "invalid_priority" });
    }
  } finally {
    cleanup();
  }
});
