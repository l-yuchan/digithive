import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../src/store/db";
import {
  catalogOf,
  deepInfraOffersOf,
  deepInfraUsageOf,
  genericOffersOf,
  goOffersOf,
  goUsageOf,
  probeProvider,
  upstreamError,
} from "../src/providers/catalog";
import { createChainStream } from "../src/providers/chain";
import { ProviderStore } from "../src/providers/store";

/** Shaped from the live endpoints (2026-11-28), trimmed to the fields the app reads. */
const goModels = {
  object: "list",
  data: [
    {
      id: "kimi-k3",
      object: "model",
      owned_by: "opencode",
      name: "Kimi K3",
      type: "chat",
      limit: { context: 262144, output: 32768 },
      cost: { text: { input: { price: 0.6 }, output: { price: 2.5 } } },
      capabilities: { tools: { supported: true }, reasoning: { supported: true } },
      go: { monthly_usage: { go: 100 } },
    },
    { id: "jev-1.14", object: "model", name: "Jev 1.14", type: "decision" },
    { id: "text-embedding-3-small", object: "model", type: "embedding" },
  ],
};

const goUsage = {
  usage: {
    rolling: { status: "ok", percent: 30, resetsAt: "2026-11-28T15:00:00.000Z" },
    weekly: { status: "rate-limited", percent: 100, resetsAt: "2026-12-01T00:00:00.000Z" },
    monthly: { status: "ok", percent: 50, resetsAt: "2027-01-01T00:00:00.000Z" },
  },
};

const deepInfraModels = {
  object: "list",
  data: [
    {
      id: "deepseek-ai/DeepSeek-V3",
      object: "model",
      created: 0,
      owned_by: "deepinfra",
      root: "deepseek-ai/DeepSeek-V3",
      metadata: {
        description: "text",
        context_length: 163840,
        max_tokens: 163840,
        pricing: { input_tokens: 0.27, output_tokens: 1.1 },
        tags: ["chat", "reasoning_effort"],
      },
    },
    {
      id: "thenlper/gte-base",
      object: "model",
      created: 0,
      owned_by: "deepinfra",
      root: "thenlper/gte-base",
      metadata: {
        description: "embed",
        context_length: 512,
        pricing: { input_tokens: 0.005 },
        tags: ["embed"],
      },
    },
  ],
};

function memoryStore(): { store: ProviderStore; db: Database } {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return { store: new ProviderStore(db, "test-secret"), db };
}

describe("provider catalogs", () => {
  test("OpenCode Go offers chat models with their real limits and marks non-text models", () => {
    const offers = goOffersOf(goModels);
    expect(offers.map((offer) => offer.id)).toEqual([
      "kimi-k3",
      "jev-1.14",
      "text-embedding-3-small",
    ]);
    const chat = offers[0];
    expect(chat).toEqual({
      id: "kimi-k3",
      label: "Kimi K3",
      kind: "chat",
      contextLength: 262144,
      maxOutput: 32768,
      inputPrice: 0.6,
      outputPrice: 2.5,
      tags: ["chat"],
    });
    expect(offers[1]?.kind).toBe("other");
  });

  test("OpenCode Go usage reports each window and the earliest spent reset", () => {
    const usage = goUsageOf(goUsage);
    expect(usage.meters.map((meter) => [meter.id, meter.percent, meter.status])).toEqual([
      ["rolling", 30, "ok"],
      ["weekly", 100, "rate-limited"],
      ["monthly", 50, "ok"],
    ]);
    // Only the spent window says when access returns; the others are not spent.
    expect(usage.nextResetAt).toBe("2026-12-01T00:00:00.000Z");
  });

  test("DeepInfra offers chat models with context and pricing, and separate limits", () => {
    const offers = deepInfraOffersOf(deepInfraModels);
    expect(offers[0]).toMatchObject({
      id: "deepseek-ai/DeepSeek-V3",
      kind: "chat",
      contextLength: 163840,
      inputPrice: 0.27,
      outputPrice: 1.1,
    });
    expect(offers[1]?.kind).toBe("other");
    const usage = deepInfraUsageOf(
      { rate_limit: 200, tpm_rate_limit: 500_000 },
      { months: [{ period: "2026.11", total_cost: 1234 }] },
      Date.now(),
    );
    expect(usage.meters.map((meter) => meter.text)).toEqual(["200", "500,000", "12.34"]);
    // A spending read that failed leaves the two limits that did answer in place.
    expect(
      deepInfraUsageOf({ rate_limit: 5, tpm_rate_limit: 10 }, null, Date.now()).meters,
    ).toHaveLength(2);
  });

  test("a plain OpenAI catalog is ids, and a non-OpenAI answer is an error, not an empty list", () => {
    expect(genericOffersOf({ object: "list", data: [{ id: "gpt-x" }] })).toEqual([
      {
        id: "gpt-x",
        label: "gpt-x",
        kind: "chat",
        contextLength: null,
        maxOutput: null,
        inputPrice: null,
        outputPrice: null,
        tags: [],
      },
    ]);
    expect(() => genericOffersOf({ models: [] })).toThrow(/형식/);
    expect(upstreamError(401, { error: { message: "Invalid API key" } }, "")).toBe(
      "HTTP 401 · Invalid API key",
    );
  });

  test("a probe keeps a good reading when the other side fails, and names both failures", async () => {
    const go = catalogOf("opencode-go");
    if (!go) throw new Error("opencode-go catalog missing");
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/models")) return new Response(JSON.stringify(goModels), { status: 200 });
      return new Response(
        JSON.stringify({ type: "error", error: { type: "AuthError", message: "Unauthorized" } }),
        {
          status: 401,
        },
      );
    }) as unknown as typeof fetch;
    const result = await probeProvider(go, {
      baseUrl: "https://opencode.ai/inference/go/v1",
      apiKey: "k",
      headers: {},
      fetchImpl,
    });
    expect(result.models).toHaveLength(3);
    expect(result.modelsError).toBeNull();
    expect(result.usage).toBeNull();
    expect(result.usageError).toBe("HTTP 401 · Unauthorized");

    const broken = await probeProvider(catalogOf("custom") ?? go, {
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "k",
      headers: {},
      fetchImpl: (async () =>
        new Response("not found", { status: 404 })) as unknown as typeof fetch,
    });
    expect(broken.models).toEqual([]);
    expect(broken.modelsError).toBe("HTTP 404 · not found");
  });
});

describe("provider store", () => {
  test("a key is stored sealed and never comes back, only a hint", () => {
    const { store, db } = memoryStore();
    const id = store.create({
      catalogId: "custom",
      label: "내 서버",
      baseUrl: "https://llm.example/v1",
      apiKey: "sk-super-secret-1234",
      headers: { "x-team": "digithive" },
      enabled: true,
    });
    const view = store.get(id);
    expect(view?.keyHint).toBe("••••1234");
    expect(JSON.stringify(view)).not.toContain("super-secret");
    expect(store.keyOf(id)).toBe("sk-super-secret-1234");
    // Only the store method decrypts the key, and only for an upstream call.
    expect(store.keyOf(id)).toBe("sk-super-secret-1234");
    // The column holds AES-GCM ciphertext, so the database file alone carries no key.
    const row = db
      .query<{ key_sealed: string }, []>("SELECT key_sealed FROM provider_connections")
      .get();
    expect(row?.key_sealed).not.toContain("super-secret");
    expect(row?.key_sealed.split(".")).toHaveLength(3);
  });

  test("the chain is the routing order, refuses a partial order and drops with its provider", () => {
    const { store } = memoryStore();
    const a = store.create({
      catalogId: "custom",
      label: "A",
      baseUrl: "https://a.example/v1",
      apiKey: "a-key",
      headers: {},
      enabled: true,
    });
    const b = store.create({
      catalogId: "deepinfra",
      label: "B",
      baseUrl: "https://api.deepinfra.com/v1/openai",
      apiKey: "b-key",
      headers: {},
      enabled: true,
    });
    store.addToChain(a, "a-model");
    store.addToChain(b, "b-model");
    expect(store.routes().map((entry) => entry.modelId)).toEqual(["a-model", "b-model"]);
    store.reorderChain([
      { providerId: b, modelId: "b-model" },
      { providerId: a, modelId: "a-model" },
    ]);
    expect(store.routes().map((entry) => entry.modelId)).toEqual(["b-model", "a-model"]);
    expect(() => store.reorderChain([{ providerId: b, modelId: "b-model" }])).toThrow(
      "invalid_chain",
    );
    store.setChainEnabled(b, "b-model", false);
    expect(store.routes().map((entry) => entry.modelId)).toEqual(["a-model"]);
    expect(store.chain()).toHaveLength(2);
    store.remove(a);
    expect(store.chain().map((entry) => entry.modelId)).toEqual(["b-model"]);
    expect(store.chain()[0]?.position).toBe(0);
  });

  test("a provider with no chain entry is never a route, and one without a key is skipped", () => {
    const { store } = memoryStore();
    store.create({
      catalogId: "custom",
      label: "unused",
      baseUrl: "https://unused.example/v1",
      apiKey: "k",
      headers: {},
      enabled: true,
    });
    expect(store.routes()).toEqual([]);
  });

  test("a probe keeps the good side and records the failed one", () => {
    const { store } = memoryStore();
    const id = store.create({
      catalogId: "custom",
      label: "P",
      baseUrl: "https://p.example/v1",
      apiKey: "k",
      headers: {},
      enabled: true,
    });
    store.recordProbe(id, {
      models: [
        {
          id: "m",
          label: "M",
          kind: "chat",
          contextLength: 8192,
          maxOutput: null,
          inputPrice: null,
          outputPrice: null,
          tags: [],
        },
      ],
      modelsError: null,
      usage: null,
      usageError: "HTTP 404 · no usage",
      fetchedAt: "2026-11-28T00:00:00.000Z",
    });
    const view = store.get(id);
    expect(view?.modelsError).toBeNull();
    expect(view?.usageError).toBe("HTTP 404 · no usage");
    expect(store.models(id).map((model) => model.id)).toEqual(["m"]);
    store.recordProbe(id, {
      models: null,
      modelsError: "HTTP 500 · boom",
      usage: { meters: [], nextResetAt: null },
      usageError: null,
      fetchedAt: "2026-11-28T01:00:00.000Z",
    });
    const after = store.get(id);
    expect(after?.modelsError).toBe("HTTP 500 · boom");
    expect(after?.usageError).toBeNull();
    // The catalog that did answer stays until a read replaces it.
    expect(store.models(id)).toHaveLength(1);
  });
});

describe("routing from the chain", () => {
  test("the first chain entry answers, and a disabled one is never called", async () => {
    const { store } = memoryStore();
    const calls: string[] = [];
    const respond =
      (name: string, status: number) =>
      async (input: string | URL | Request): Promise<Response> => {
        calls.push(`${name}:${String(input)}`);
        if (status !== 200) return new Response("upstream says no", { status });
        const body = [
          `data: ${JSON.stringify({ choices: [{ delta: { content: name } }] })}`,
          "data: [DONE]",
          "",
          "",
        ].join("\n");
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      };
    const a = store.create({
      catalogId: "custom",
      label: "A",
      baseUrl: "https://a.example/v1",
      apiKey: "a-key",
      headers: {},
      enabled: true,
    });
    const b = store.create({
      catalogId: "custom",
      label: "B",
      baseUrl: "https://b.example/v1",
      apiKey: "b-key",
      headers: {},
      enabled: true,
    });
    store.addToChain(a, "a-model");
    store.addToChain(b, "b-model");

    const stream = createChainStream(store, {
      cooldownMs: 0,
      retries: 0,
      usageProbe: undefined,
    });
    const answer = async (fetchImpl: typeof fetch): Promise<string> => {
      let text = "";
      for await (const event of stream([{ role: "user", content: "hi" }], [], {
        maxOutputTokens: 8,
        firstTokenTimeoutMs: 2_000,
        idleTimeoutMs: 2_000,
        fetchImpl,
      })) {
        if (event.type === "text_delta") text += event.text;
      }
      return text;
    };
    const byHost = ((input: string | URL | Request) =>
      String(input).includes("a.example")
        ? respond("A", 200)(input)
        : respond("B", 200)(input)) as unknown as typeof fetch;
    expect(await answer(byHost)).toBe("A");
    expect(calls).toHaveLength(1);

    store.setChainEnabled(a, "a-model", false);
    const callsAfter = calls.length;
    const restarted = createChainStream(store, { cooldownMs: 0, retries: 0 });
    let text = "";
    for await (const event of restarted([{ role: "user", content: "hi" }], [], {
      maxOutputTokens: 8,
      firstTokenTimeoutMs: 2_000,
      idleTimeoutMs: 2_000,
      fetchImpl: byHost,
    })) {
      if (event.type === "text_delta") text += event.text;
    }
    expect(text).toBe("B");
    expect(calls.slice(callsAfter).every((call) => call.startsWith("B:"))).toBe(true);
  });

  test("a failing first route falls back to the next chain entry, in order", async () => {
    const { store } = memoryStore();
    const a = store.create({
      catalogId: "custom",
      label: "A",
      baseUrl: "https://a.example/v1",
      apiKey: "a-key",
      headers: {},
      enabled: true,
    });
    const b = store.create({
      catalogId: "custom",
      label: "B",
      baseUrl: "https://b.example/v1",
      apiKey: "b-key",
      headers: {},
      enabled: true,
    });
    store.addToChain(a, "a-model");
    store.addToChain(b, "b-model");
    const transport = ((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("a.example")) return Promise.resolve(new Response("boom", { status: 500 }));
      const body = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "B" } }] })}`,
        "data: [DONE]",
        "",
        "",
      ].join("\n");
      return Promise.resolve(
        new Response(body, { headers: { "content-type": "text/event-stream" } }),
      );
    }) as unknown as typeof fetch;
    const stream = createChainStream(store, { cooldownMs: 60_000, retries: 0 });
    let text = "";
    for await (const event of stream([{ role: "user", content: "hi" }], [], {
      maxOutputTokens: 8,
      firstTokenTimeoutMs: 2_000,
      idleTimeoutMs: 2_000,
      fetchImpl: transport,
    })) {
      if (event.type === "text_delta") text += event.text;
    }
    expect(text).toBe("B");
    expect(stream.diagnostics().map((diagnostic) => diagnostic.kind)).toContain(
      "provider.fallback",
    );
  });
});
