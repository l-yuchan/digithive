import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { catalogOf, probeProvider } from "../src/providers/catalog";
import { ProviderStore } from "../src/providers/store";
import { createHarness, loadConfig } from "../src/server/main";
import { openDatabase } from "../src/store/db";
import { answerProviderCall, type ProviderCall } from "../scripts/qa/provider-fixture";

/**
 * A transport the app's upstream reads go through. `answer` decides each response and every
 * request is recorded, so a test can say what the app really asked for.
 */
function recordingFetch(answer: (request: Request) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: ProviderCall[];
} {
  const calls: ProviderCall[] = [];
  const inner = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push({
      path: new URL(request.url).pathname,
      method: request.method,
      authorization: request.headers.get("authorization"),
    });
    return answer(request);
  };
  // Bun's fetch type also carries `preconnect`; this transport only answers requests.
  return { fetch: Object.assign(inner, { preconnect: () => undefined }), calls };
}

const Overview = z.object({
  catalogs: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      capabilities: z.array(z.string()),
      docsUrl: z.string(),
    }),
  ),
  providers: z.array(
    z.object({
      id: z.string(),
      catalogId: z.string(),
      label: z.string(),
      baseUrl: z.string(),
      keyHint: z.string().nullable(),
      models: z.array(
        z.object({ id: z.string(), kind: z.string(), contextLength: z.number().nullable() }),
      ),
      modelsError: z.string().nullable(),
      usageError: z.string().nullable(),
      usage: z
        .object({
          meters: z.array(z.object({ id: z.string(), percent: z.number().nullable() })),
        })
        .nullable(),
    }),
  ),
  chain: z.array(
    z.object({
      providerId: z.string(),
      modelId: z.string(),
      position: z.number(),
      enabled: z.boolean(),
    }),
  ),
  routes: z.array(z.object({ name: z.string(), providerId: z.string(), modelId: z.string() })),
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "providers-http-"));
  const dbPath = join(root, "harness.db");
  const harness = createHarness(
    loadConfig({
      HARNESS_DB: dbPath,
      HARNESS_WORKSPACE: join(root, "workspace"),
      HARNESS_SESSION_SECRET: "provider-test-secret",
      MODEL_BASE_URL: "https://seed.example/v1",
      MODEL_API_KEY: "seed-key",
      MODEL_NAME: "seed-model",
    }),
  );
  const call = (path: string, method = "GET", body?: unknown) =>
    harness.handler(
      new Request(`http://local${path}`, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      }),
    );
  return {
    harness,
    call,
    cleanup: () => {
      harness.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("a new database gets the environment's routes as one provider and its chain entry", async () => {
  const { call, cleanup } = setup();
  try {
    const response = await call("/api/providers");
    expect(response.status).toBe(200);
    const body = Overview.parse(await response.json());
    expect(body.catalogs.map((catalog) => catalog.id)).toEqual([
      "opencode-go",
      "deepinfra",
      "custom",
    ]);
    expect(body.providers.map((provider) => provider.label)).toEqual(["seed-model"]);
    expect(body.providers[0]?.keyHint).toBe("••••-key");
    expect(body.chain.map((entry) => entry.modelId)).toEqual(["seed-model"]);
    expect(body.routes.map((route) => route.modelId)).toEqual(["seed-model"]);
    expect(JSON.stringify(body)).not.toContain("seed-key");
  } finally {
    cleanup();
  }
});

test("an OpenAI-compatible provider's catalog is read with its key and stored", async () => {
  const db = openDatabase(":memory:");
  const store = new ProviderStore(db, "provider-test-secret");
  const network = recordingFetch(answerProviderCall);
  const providerId = store.create({
    catalogId: "custom",
    label: "내 로컬",
    baseUrl: "https://custom.example/v1",
    apiKey: "custom-key-9999",
    headers: {},
    enabled: true,
  });
  const catalog = catalogOf("custom");
  if (!catalog) throw new Error("custom catalog missing");
  const probe = await probeProvider(catalog, {
    baseUrl: "https://custom.example/v1",
    apiKey: "custom-key-9999",
    headers: {},
    fetchImpl: network.fetch,
  });
  expect(probe.models.map((model) => model.id)).toEqual([
    "qa-model-fast",
    "qa-model-strong",
    "qa-model-broken",
  ]);
  expect(network.calls).toEqual([
    { path: "/v1/models", method: "GET", authorization: "Bearer custom-key-9999" },
  ]);
  store.recordProbe(providerId, {
    models: probe.models,
    modelsError: probe.modelsError,
    usage: probe.usage,
    usageError: probe.usageError,
    fetchedAt: probe.fetchedAt,
  });
  // The stored catalog is kept in the order the screen shows it: chat models by name.
  expect(store.models(providerId).map((model) => model.id)).toEqual([
    "qa-model-broken",
    "qa-model-fast",
    "qa-model-strong",
  ]);
  db.close();
});

test("an OpenAI-compatible provider is added, chained, switched off and deleted", async () => {
  const { call, cleanup } = setup();
  try {
    const created = await call("/api/providers", "POST", {
      catalogId: "custom",
      label: "내 로컬",
      baseUrl: "https://custom.example/v1",
      apiKey: "custom-key-9999",
    });
    // Without a reachable network the creation still succeeds and records why the read failed.
    expect(created.status).toBe(201);
    const createdBody = z
      .object({
        provider: z.object({ id: z.string(), label: z.string(), keyHint: z.string().nullable() }),
        probe: z.object({ modelsError: z.string().nullable(), stored: z.boolean() }),
      })
      .parse(await created.json());
    expect(createdBody.provider.label).toBe("내 로컬");
    expect(createdBody.provider.keyHint).toBe("••••9999");
    expect(createdBody.probe.stored).toBe(true);

    const added = await call("/api/settings/models", "POST", {
      providerId: createdBody.provider.id,
      modelId: "manual-model",
    });
    expect(added.status).toBe(201);
    const chain = z
      .object({ chain: z.array(z.object({ modelId: z.string() })) })
      .parse(await added.json());
    expect(chain.chain.map((entry) => entry.modelId)).toEqual(["seed-model", "manual-model"]);

    const read = Overview.parse(await (await call("/api/providers")).json());
    expect(read.chain.map((entry) => entry.modelId)).toEqual(["seed-model", "manual-model"]);
    expect(read.routes.map((route) => route.modelId)).toEqual(["seed-model", "manual-model"]);

    // Disabling a provider removes it from the routes without touching its definition.
    const patched = await call(`/api/providers/${createdBody.provider.id}`, "PATCH", {
      enabled: false,
    });
    expect(patched.status).toBe(200);
    const afterDisable = Overview.parse(await patched.json());
    expect(afterDisable.routes.map((route) => route.modelId)).toEqual(["seed-model"]);
    expect(afterDisable.chain).toHaveLength(2);

    // Deleting it takes its chain entry with it.
    const deleted = await call(`/api/providers/${createdBody.provider.id}`, "DELETE");
    const afterDelete = Overview.parse(await deleted.json());
    expect(afterDelete.providers.map((provider) => provider.label)).toEqual(["seed-model"]);
    expect(afterDelete.chain.map((entry) => entry.modelId)).toEqual(["seed-model"]);
  } finally {
    cleanup();
  }
});

test("an unknown catalog, a malformed base URL and a bad patch are refused with their reason", async () => {
  const { call, cleanup } = setup();
  try {
    expect((await call("/api/providers", "POST", { catalogId: "nope" })).status).toBe(422);
    expect(
      (await call("/api/providers", "POST", { catalogId: "custom", baseUrl: "ftp://x" })).status,
    ).toBe(422);
    // A custom provider has no predefined base URL, so it must be given one.
    expect((await call("/api/providers", "POST", { catalogId: "custom" })).status).toBe(422);
    expect((await call("/api/providers/missing", "PATCH", { label: "x" })).status).toBe(404);
    expect((await call("/api/providers/missing", "DELETE")).status).toBe(404);
    const badHeader = await call("/api/providers", "POST", {
      catalogId: "deepinfra",
      apiKey: "k",
      headers: { "bad header name": "v" },
    });
    expect(badHeader.status).toBe(422);
  } finally {
    cleanup();
  }
});

test("the chain refuses anything but an exact permutation of itself", async () => {
  const { call, cleanup } = setup();
  try {
    for (const body of [{}, { entries: "x" }, { entries: [{ providerId: "a", modelId: "b" }] }]) {
      const response = await call("/api/settings/models", "PUT", body);
      expect(response.status).toBe(422);
    }
  } finally {
    cleanup();
  }
});
