import { z } from "zod";
import type { Database } from "bun:sqlite";
import { buildRouterRoutes, routeNameOf, type ResolvedRoute } from "../providers/routes";
import {
  catalogOf,
  probeProvider,
  PROVIDER_CATALOGS,
  type ProbeResult,
} from "../providers/catalog";
import { type ChainEntry, type ProviderStore, type ProviderView } from "../providers/store";

/** Header names a request may carry: an HTTP token, never a placeholder. */
const HeaderName = z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, "invalid_header_name");
const RequestHeaders = z.record(HeaderName, z.string().max(2_000));

export type ProviderRouteDeps = {
  readonly db: Database;
  readonly providers: ProviderStore;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function decodeSegment(segment: string | undefined): string {
  if (segment === undefined) return "";
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clip(text: string): string {
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

const HttpUrl = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => /^https?:\/\/[^\s]+$/.test(value), "base_url_scheme");

const CreateBody = z.object({
  catalogId: z.string().min(1),
  label: z.string().trim().max(80).optional(),
  baseUrl: HttpUrl.optional(),
  apiKey: z.string().max(2_000).optional(),
  headers: RequestHeaders.optional(),
  enabled: z.boolean().optional(),
});

/** A patch names only what it changes; an absent key keeps the stored one. */
const PatchBody = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  baseUrl: HttpUrl.optional(),
  apiKey: z.string().max(2_000).optional(),
  headers: RequestHeaders.optional(),
  enabled: z.boolean().optional(),
});

const ChainEntryBody = z.object({ providerId: z.string().min(1), modelId: z.string().min(1) });

/** The router's path for one chain entry, as the screen shows it. */
function routesOf(deps: ProviderRouteDeps) {
  // `routes()` already leaves out a disabled chain entry or provider, so what remains is
  // exactly what a model call may reach.
  const enabled: ResolvedRoute[] = deps.providers.routes().map((entry) => ({
    position: entry.position,
    providerId: entry.providerId,
    providerLabel: entry.providerLabel,
    modelId: entry.modelId,
    baseUrl: entry.baseUrl,
    apiKey: deps.providers.keyOf(entry.providerId) ?? "",
  }));
  return buildRouterRoutes(enabled).map((route) => ({
    name: route.name,
    providerId: route.provider,
    providerLabel:
      enabled.find((entry) => routeNameOf(entry) === route.name)?.providerLabel ?? route.provider,
    modelId: route.model,
    baseUrl: route.baseUrl,
  }));
}

/** Everything the settings screen renders, in one shape. No key is ever part of it. */
function overviewOf(deps: ProviderRouteDeps) {
  return {
    catalogs: PROVIDER_CATALOGS.map((catalog) => ({
      id: catalog.id,
      label: catalog.label,
      description: catalog.description,
      baseUrl: catalog.baseUrl,
      docsUrl: catalog.docsUrl,
      capabilities: catalog.capabilities,
    })),
    providers: deps.providers.list().map((provider) => {
      const catalog = catalogOf(provider.catalogId);
      return {
        ...provider,
        models: deps.providers.models(provider.id),
        catalog: {
          label: catalog?.label ?? provider.catalogId,
          capabilities: catalog?.capabilities ?? [],
          docsUrl: catalog?.docsUrl ?? "",
          known: catalog !== null,
        },
      };
    }),
    chain: deps.providers.chain(),
    routes: routesOf(deps),
  };
}

/**
 * Reads the provider through its catalog and stores the outcome. A failure is stored and
 * returned with the provider's own words; it never turns into an empty success.
 */
async function probeAndStore(
  deps: ProviderRouteDeps,
  provider: ProviderView,
): Promise<ProbeResult & { readonly stored: boolean }> {
  const catalog = catalogOf(provider.catalogId);
  const key = deps.providers.keyOf(provider.id);
  if (catalog === null || key === null) {
    const error =
      catalog === null ? "알 수 없는 공급자 종류입니다." : "저장된 키를 읽을 수 없습니다.";
    deps.providers.recordProbeError(provider.id, error, error);
    return {
      models: [],
      usage: null,
      modelsError: error,
      usageError: error,
      fetchedAt: new Date().toISOString(),
      stored: false,
    };
  }
  const result = await probeProvider(catalog, {
    baseUrl: provider.baseUrl,
    apiKey: key,
    headers: provider.headers,
  });
  deps.providers.recordProbe(provider.id, {
    models: result.modelsError === null ? result.models : null,
    modelsError: result.modelsError,
    usage: result.usageError === null ? result.usage : null,
    usageError: result.usageError,
    fetchedAt: result.fetchedAt,
  });
  return { ...result, stored: true };
}

/**
 * One real chat call to one model, so the owner learns whether it works without sending a
 * conversation. The upstream answer, or its error, is repeated as received.
 */
async function testModel(deps: ProviderRouteDeps, provider: ProviderView, modelId: string) {
  const key = deps.providers.keyOf(provider.id);
  if (key === null) return { ok: false, error: "저장된 키를 읽을 수 없습니다." };
  const started = Date.now();
  const endpoint = `${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        ...(provider.catalogId === "opencode-go"
          ? { "x-opencode-session": `digithive-test-${provider.id}` }
          : {}),
        ...provider.headers,
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 16,
        messages: [{ role: "user", content: "연결 확인. 한 단어로 답하세요." }],
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    const latencyMs = Date.now() - started;
    if (!response.ok) return { ok: false, status: response.status, latencyMs, error: clip(text) };
    const answer = z
      .object({
        choices: z.array(
          z.object({ message: z.object({ content: z.string().nullish() }).optional() }),
        ),
      })
      .safeParse(safeJson(text));
    return {
      ok: true,
      status: response.status,
      latencyMs,
      answer: answer.success ? (answer.data.choices[0]?.message?.content ?? null) : null,
      body: clip(text),
    };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, error: messageOf(error) };
  } finally {
    clearTimeout(timer);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * `/api/providers` and `/api/settings/models` — the owner's providers and routing chain.
 *
 * Every read is built from the store's public view, which carries a key hint and never a
 * key, so no route here can leak a credential.
 */
export async function handleProviderRequest(
  request: Request,
  deps: ProviderRouteDeps,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith("/api/providers") && !path.startsWith("/api/settings/models")) return null;

  try {
    if (path === "/api/providers" && request.method === "GET") return json(overviewOf(deps));

    if (path === "/api/providers" && request.method === "POST") {
      const parsed = CreateBody.safeParse(await request.json().catch(() => null));
      if (!parsed.success)
        return json({ error: "invalid_provider", detail: parsed.error.message }, 422);
      const catalog = catalogOf(parsed.data.catalogId);
      if (catalog === null) return json({ error: "unknown_catalog" }, 422);
      const baseUrl = parsed.data.baseUrl ?? catalog.baseUrl;
      if (baseUrl === null) return json({ error: "base_url_required" }, 422);
      const id = deps.providers.create({
        catalogId: catalog.id,
        label: parsed.data.label ?? catalog.label,
        baseUrl,
        apiKey: parsed.data.apiKey ? parsed.data.apiKey : null,
        headers: parsed.data.headers ?? {},
        enabled: parsed.data.enabled ?? true,
      });
      const created = deps.providers.get(id);
      if (created === null) return json({ error: "provider_not_stored" }, 500);
      // A new provider is read once right away, so the picker has models without a second
      // request; a read failure is stored and returned rather than failing the creation.
      const probe = await probeAndStore(deps, created);
      return json(
        {
          provider: { ...(deps.providers.get(id) ?? created), models: deps.providers.models(id) },
          probe,
          ...overviewOf(deps),
        },
        201,
      );
    }

    const match = /^\/api\/providers\/([^/]+)(?:\/(models|probe|test))?$/.exec(path);
    if (match) {
      const id = decodeSegment(match[1]);
      const provider = deps.providers.get(id);
      if (provider === null) return json({ error: "provider_not_found" }, 404);
      const action = match[2];

      if (action === undefined && request.method === "PATCH") {
        const parsed = PatchBody.safeParse(await request.json().catch(() => null));
        if (!parsed.success)
          return json({ error: "invalid_provider", detail: parsed.error.message }, 422);
        deps.providers.update(id, {
          ...(parsed.data.label === undefined ? {} : { label: parsed.data.label }),
          ...(parsed.data.baseUrl === undefined ? {} : { baseUrl: parsed.data.baseUrl }),
          ...(parsed.data.apiKey === undefined || parsed.data.apiKey.length === 0
            ? {}
            : { apiKey: parsed.data.apiKey }),
          ...(parsed.data.headers === undefined ? {} : { headers: parsed.data.headers }),
          ...(parsed.data.enabled === undefined ? {} : { enabled: parsed.data.enabled }),
        });
        return json({ provider: deps.providers.get(id), ...overviewOf(deps) });
      }
      if (action === undefined && request.method === "DELETE") {
        const removed = deps.providers.remove(id);
        return json({ removed, ...overviewOf(deps) });
      }
      if (action === "models" && request.method === "GET")
        return json({ provider, models: deps.providers.models(id) });
      if (action === "probe" && request.method === "POST") {
        const probe = await probeAndStore(deps, provider);
        return json({ probe, ...overviewOf(deps) });
      }
      if (action === "test" && request.method === "POST") {
        const parsed = z
          .object({ modelId: z.string().min(1) })
          .safeParse(await request.json().catch(() => null));
        if (!parsed.success) return json({ error: "model_required" }, 422);
        return json(await testModel(deps, provider, parsed.data.modelId));
      }
      return json({ error: "method_not_allowed" }, 405);
    }

    if (path === "/api/settings/models") {
      if (request.method === "GET")
        return json({ chain: deps.providers.chain(), routes: routesOf(deps) });
      if (request.method === "POST") {
        const parsed = ChainEntryBody.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return json({ error: "invalid_chain_entry" }, 422);
        if (deps.providers.get(parsed.data.providerId) === null)
          return json({ error: "provider_not_found" }, 404);
        deps.providers.addToChain(parsed.data.providerId, parsed.data.modelId);
        return json({ chain: deps.providers.chain(), routes: routesOf(deps) }, 201);
      }
      if (request.method === "PUT") {
        const parsed = z
          .object({ entries: z.array(ChainEntryBody).max(200) })
          .safeParse(await request.json().catch(() => null));
        if (!parsed.success) return json({ error: "invalid_chain" }, 422);
        try {
          deps.providers.reorderChain(parsed.data.entries);
        } catch (error) {
          return json({ error: messageOf(error) }, 422);
        }
        return json({ chain: deps.providers.chain(), routes: routesOf(deps) });
      }
      if (request.method === "PATCH") {
        const parsed = z
          .object({ providerId: z.string(), modelId: z.string(), enabled: z.boolean() })
          .safeParse(await request.json().catch(() => null));
        if (!parsed.success) return json({ error: "invalid_chain_entry" }, 422);
        deps.providers.setChainEnabled(
          parsed.data.providerId,
          parsed.data.modelId,
          parsed.data.enabled,
        );
        return json({ chain: deps.providers.chain(), routes: routesOf(deps) });
      }
      if (request.method === "DELETE") {
        const providerId = url.searchParams.get("providerId") ?? "";
        const modelId = url.searchParams.get("modelId") ?? "";
        if (providerId.length === 0 || modelId.length === 0)
          return json({ error: "invalid_chain_entry" }, 422);
        deps.providers.removeFromChain(providerId, modelId);
        return json({ chain: deps.providers.chain(), routes: routesOf(deps) });
      }
      return json({ error: "method_not_allowed" }, 405);
    }

    if (path === "/api/settings/models/test" && request.method === "POST") {
      const parsed = ChainEntryBody.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return json({ error: "invalid_chain_entry" }, 422);
      const provider = deps.providers.get(parsed.data.providerId);
      if (provider === null) return json({ error: "provider_not_found" }, 404);
      return json(await testModel(deps, provider, parsed.data.modelId));
    }

    return json({ error: "not_found" }, 404);
  } catch (error) {
    return json({ error: messageOf(error) }, 500);
  }
}

export type { ChainEntry };
