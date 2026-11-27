import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { catalogOf, probeProvider } from "../src/providers/catalog";
import { ProviderStore } from "../src/providers/store";
import { createHarness, loadConfig } from "../src/server/main";
import { openDatabase } from "../src/store/db";

/**
 * A stand-in OpenAI-compatible server: its catalog, its chat completions, and a record of
 * every path it was asked for, so a test can tell which endpoints the app really calls.
 */
function fakeServer(routes: Record<string, (request: Request) => Response | Promise<Response>>): {
  readonly fetchImpl: typeof fetch;
  readonly calls: { method: string; path: string; headers: Record<string, string> }[];
} {
  const calls: { method: string; path: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({ method: init?.method ?? "GET", path: url.pathname, headers });
    const handler = routes[url.pathname];
    if (!handler) return new Response(`no route ${url.pathname}`, { status: 404 });
    return handler(new Request(url, init));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
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

test("an OpenAI-compatible provider's catalog is read with its key and stored", async () => {
  const db = openDatabase(":memory:");
  const store = new ProviderStore(db, "provider-test-secret");
  const server = fakeServer({
    "/v1/models": () =>
      Response.json({ object: "list", data: [{ id: "local-a" }, { id: "local-b" }] }),
  });
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
    fetchImpl: server.fetchImpl,
  });
  expect(probe.models.map((model) => model.id)).toEqual(["local-a", "local-b"]);
  expect(server.calls[0]?.path).toBe("/v1/models");
  expect(server.calls[0]?.headers["authorization"]).toBe("Bearer custom-key-9999");
  store.recordProbe(providerId, {
    models: probe.models,
    modelsError: probe.modelsError,
    usage: probe.usage,
    usageError: probe.usageError,
    fetchedAt: probe.fetchedAt,
  });
  expect(store.models(providerId).map((model) => model.id)).toEqual(["local-a", "local-b"]);
  db.close();
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
    dbPath,
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

test("an OpenAI-compatible provider is added, listed, chained and readable", async () => {
  const { call, cleanup } = setup();
  // The seeded provider is the only one on this database; the added one is the owner's.
  try {
    const created = await call("/api/providers", "POST", {
      catalogId: "custom",
      label: "내 로컬",
      baseUrl: "https://custom.example/v1",
      apiKey: "custom-key-9999",
    });
    // Without a network the creation still succeeds and records why the read failed.
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
    expect((await call("/api/providers", "POST", { catalogId: "custom" })).status).toBe(422); // custom has no predefined base URL
    expect((await call("/api/providers/missing", "PATCH", { label: "x" })).status).toBe(404);
    expect((await call("/api/providers/missing", "DELETE")).status).toBe(404);
    const deepinfra = await call("/api/providers", "POST", {
      catalogId: "deepinfra",
      apiKey: "k",
      headers: { "bad header name": "v" },
    });
    expect(deepinfra.status).toBe(422);
  } finally {
    cleanup();
  }
});

test("the chain refuses a name that is not an exact permutation of itself", async () => {
  const { call, cleanup } = setup();
  try {
    for (const body of [{}, { entries: "x" }, { entries: [{ providerId: "a", modelId: "b" }] }]) {
      const response = await call("/api/settings/models", "PUT", body);
      expect([422, 404]).toContain(response.status);
    }
  } finally {
    cleanup();
  }
});
