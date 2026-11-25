import type { Database } from "bun:sqlite";
import type { EventLog } from "../events/log";
import type { CanvasConfig } from "../integrations/canvas";
import {
  bindGoogleIdentity,
  consumeOAuthState,
  createOAuthState,
  deleteAccount,
  getAccount,
  listAccounts,
  setSourceEnabled,
  sourcesForProvider,
  upsertGoogleAccount,
  type SourceName,
} from "../integrations/accounts";
import {
  authUrl,
  exchangeCode,
  fetchGoogleIdentity,
  hydrateGoogleEmail,
  saveTokens,
  type GoogleDeps,
} from "../integrations/google";
import { syncEnabledSources } from "../integrations/sync";
import { z } from "zod";

/** The same object shape the app already assembles for Google and Canvas. */
export type AccountRouteDeps = {
  readonly google: GoogleDeps;
  readonly canvas: {
    readonly db: Database;
    readonly events: EventLog;
    readonly config: CanvasConfig;
  };
  readonly auth: { readonly passphrase: string; readonly secret: string };
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function accountJson(deps: AccountRouteDeps, canvasConnected: boolean) {
  return listAccounts(deps.google.db, { canvasConfigured: canvasConnected }).map((account) => ({
    id: account.id,
    provider: account.provider,
    subject: account.subject,
    email: account.email,
    label: account.label,
    connected: account.connected,
    sources: account.sources.map((source) => ({
      source: source.source,
      enabled: source.enabled,
      ok: source.ok,
      cursor: source.cursor,
      lastSyncAt: source.lastSyncAt,
      lastAttemptAt: source.lastAttemptAt,
      error: source.error,
    })),
  }));
}

function canvasConfigured(deps: AccountRouteDeps): boolean {
  return deps.canvas.config.baseUrl.trim().length > 0 && deps.canvas.config.token.trim().length > 0;
}

const SOURCE_NAMES: readonly SourceName[] = ["calendar", "gmail", "canvas"];

function parseSource(value: string): SourceName | null {
  return SOURCE_NAMES.find((source) => source === value) ?? null;
}

function redirect(url: URL, query: Record<string, string>): Response {
  const target = new URL("/", url.origin);
  for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value);
  return new Response(null, {
    status: 302,
    headers: { location: target.toString(), "cache-control": "no-store" },
  });
}

async function handleOAuthStart(request: Request, deps: AccountRouteDeps): Promise<Response> {
  const config = deps.google.config;
  if (config.clientId.trim().length === 0 || config.clientSecret.trim().length === 0) {
    return json(
      {
        error: "google_not_configured",
        detail: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured before connecting",
      },
      409,
    );
  }
  const url = new URL(request.url);
  const accountId = url.searchParams.get("accountId");
  if (accountId) {
    const account = getAccount(deps.google.db, accountId);
    if (!account) return json({ error: "account_not_found", detail: accountId }, 404);
    if (account.provider !== "google")
      return json(
        { error: "account_not_google", detail: `${accountId} is a ${account.provider} account` },
        422,
      );
  }
  const state = createOAuthState(deps.google.db, accountId ?? null, Date.now());
  return new Response(null, {
    status: 302,
    headers: { location: authUrl(config, state), "cache-control": "no-store" },
  });
}

async function handleOAuthCallback(request: Request, deps: AccountRouteDeps): Promise<Response> {
  const url = new URL(request.url);
  const providerError = url.searchParams.get("error");
  if (providerError) return redirect(url, { oauth: "error", reason: providerError });
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return redirect(url, { oauth: "error", reason: "state_missing" });

  const challenge = consumeOAuthState(deps.google.db, state, Date.now());
  if (!challenge.ok) return redirect(url, { oauth: "error", reason: `state_${challenge.reason}` });

  try {
    const fetchImpl = deps.google.fetchImpl ?? fetch;
    const tokens = await exchangeCode(deps.google.config, code, fetchImpl, Date.now());
    const identity = await fetchGoogleIdentity(fetchImpl, tokens.accessToken);

    if (challenge.accountId) {
      const target = getAccount(deps.google.db, challenge.accountId);
      if (!target) return redirect(url, { oauth: "error", reason: "account_missing" });
      if (target.provider !== "google")
        return redirect(url, { oauth: "error", reason: "identity_mismatch" });
      if (!target.subject) await hydrateGoogleEmail(deps.google, target.id);
      const bound = bindGoogleIdentity(deps.google.db, target.id, identity);
      if (!bound.ok) {
        deps.google.events.append({
          kind: "integration.sync_state",
          payload: {
            accountId: target.id,
            source: "google",
            ok: false,
            error: bound.reason,
          },
        });
        return redirect(url, { oauth: "error", reason: bound.reason });
      }
      saveTokens(deps.google.db, deps.google.vaultSecret, tokens, target.id);
      deps.google.events.append({
        kind: "integration.connected",
        payload: { provider: "google", accountId: target.id, subject: identity.subject },
      });
      await syncEnabledSources({ google: deps.google, canvas: deps.canvas }, target.id);
      return redirect(url, { oauth: "ok", account: target.id });
    }

    // A legacy row may lack the email that makes a verified merge possible.
    await hydrateGoogleEmail(deps.google);
    const account = upsertGoogleAccount(deps.google.db, {
      subject: identity.subject,
      email: identity.email,
    });
    saveTokens(deps.google.db, deps.google.vaultSecret, tokens, account.id);
    deps.google.events.append({
      kind: "integration.connected",
      payload: {
        provider: "google",
        accountId: account.id,
        subject: identity.subject,
        created: account.created,
      },
    });
    await syncEnabledSources({ google: deps.google, canvas: deps.canvas }, account.id);
    return redirect(url, { oauth: "ok", account: account.id });
  } catch (error) {
    deps.google.events.append({
      kind: "integration.sync_state",
      payload: {
        source: "google",
        ok: false,
        error: error instanceof Error ? error.message : "oauth_failed",
      },
    });
    return redirect(url, { oauth: "error", reason: "oauth_failed" });
  }
}

/**
 * Account, source toggle, delete, sync and Google OAuth routes. Returns null for
 * every other path so the main app keeps ownership of the rest of the API.
 */
export async function handleAccountRequest(
  request: Request,
  deps: AccountRouteDeps,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/accounts" && request.method === "GET") {
    return json({
      accounts: accountJson(deps, canvasConfigured(deps)),
      googleConfigured:
        deps.google.config.clientId.trim().length > 0 &&
        deps.google.config.clientSecret.trim().length > 0,
      canvasConfigured: canvasConfigured(deps),
    });
  }

  const sourceMatch = /^\/api\/accounts\/([^/]+)\/sources\/([^/]+)$/.exec(path);
  if (sourceMatch && request.method === "PATCH") {
    const accountId = decodeURIComponent(sourceMatch[1] ?? "");
    const source = parseSource(decodeURIComponent(sourceMatch[2] ?? ""));
    const parsed = z
      .object({ enabled: z.boolean() })
      .safeParse(await request.json().catch(() => null));
    if (!source)
      return json(
        { error: "invalid_source", detail: "source must be calendar, gmail or canvas" },
        422,
      );
    if (!parsed.success)
      return json({ error: "invalid_body", detail: 'body must be {"enabled": boolean}' }, 422);
    const account = getAccount(deps.google.db, accountId);
    if (!account) return json({ error: "account_not_found", detail: accountId }, 404);
    if (!sourcesForProvider(account.provider).includes(source))
      return json(
        {
          error: "source_not_supported",
          detail: `${account.provider} account supports ${sourcesForProvider(account.provider).join(", ")}`,
        },
        422,
      );
    const updated = setSourceEnabled(deps.google.db, accountId, source, parsed.data.enabled);
    if (!updated) return json({ error: "source_not_found", detail: `${accountId}/${source}` }, 404);
    deps.google.events.append({
      kind: "integration.sync_state",
      payload: { accountId, source, enabled: parsed.data.enabled },
    });
    return json({ accountId, source: updated });
  }

  const syncMatch = /^\/api\/accounts\/([^/]+)\/sync$/.exec(path);
  if (syncMatch && request.method === "POST") {
    const accountId = decodeURIComponent(syncMatch[1] ?? "");
    if (!getAccount(deps.google.db, accountId))
      return json({ error: "account_not_found", detail: accountId }, 404);
    try {
      const results = await syncEnabledSources(
        { google: deps.google, canvas: deps.canvas },
        accountId,
      );
      return json({ accountId, results });
    } catch (error) {
      return json(
        { error: "sync_failed", detail: error instanceof Error ? error.message : "unknown" },
        500,
      );
    }
  }

  const deleteMatch = /^\/api\/accounts\/([^/]+)$/.exec(path);
  if (deleteMatch && request.method === "DELETE") {
    const accountId = decodeURIComponent(deleteMatch[1] ?? "");
    if (!getAccount(deps.google.db, accountId))
      return json({ error: "account_not_found", detail: accountId }, 404);
    deleteAccount(deps.google.db, accountId);
    deps.google.events.append({
      kind: "integration.sync_state",
      payload: { accountId, deleted: true },
    });
    return json({ deleted: true, id: accountId });
  }

  if (path === "/api/oauth/google/start" && request.method === "GET")
    return handleOAuthStart(request, deps);
  if (path === "/api/oauth/google/callback" && request.method === "GET")
    return handleOAuthCallback(request, deps);

  return null;
}
