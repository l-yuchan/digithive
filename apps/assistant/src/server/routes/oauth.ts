import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
  authorizationUrl, beginAuthorization, consumeState, disconnect, ensureAccessToken,
  exchangeCode, googleConfig, GoogleAuthError, storeConnection,
} from "../../integrations/google-auth";
import type { SecretVault } from "../secrets";

const Connection = z.object({
  id: z.string(), provider: z.string(), scopes: z.array(z.string()), status: z.string(),
  lastSuccessAt: z.string().nullable(),
});
export type Connection = z.infer<typeof Connection>;

export async function oauthRoute(
  db: Database, vault: SecretVault, request: Request, path: string,
): Promise<Response> {
  if (path === "/api/oauth/google/start" && request.method === "GET") {
    try {
      const config = googleConfig();
      const { state, challenge } = beginAuthorization(db, "google", config.redirectUri);
      return new Response(null, { status: 302, headers: { location: authorizationUrl(config, state, challenge) } });
    } catch (error) {
      if (error instanceof GoogleAuthError) return Response.json({ error: "oauth_unconfigured" }, { status: 503 });
      throw error;
    }
  }
  if (path === "/api/oauth/google/callback" && request.method === "GET") {
    const url = new URL(request.url);
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    if (url.searchParams.get("error")) return Response.json({ error: "consent_denied" }, { status: 403 });
    try {
      const config = googleConfig();
      const pending = consumeState(db, state, "google");
      const tokens = await exchangeCode(config, code, pending.verifier);
      storeConnection(db, vault, "google", tokens);
      return new Response(null, { status: 303, headers: { location: "/connections?connected=google" } });
    } catch (error) {
      if (error instanceof GoogleAuthError) {
        const status = error.kind === "state_mismatch" ? 403 : 400;
        return Response.json({ error: error.kind }, { status });
      }
      throw error;
    }
  }
  if (path === "/api/connections" && request.method === "GET") {
    const rows = z.array(z.object({
      id: z.string(), provider: z.string(), scopes_json: z.string(), sync_status: z.string(),
      last_success_at: z.string().nullable(),
    })).parse(db.query("SELECT id,provider,scopes_json,sync_status,last_success_at FROM connections").all());
    const config = (() => {
      try {
        return googleConfig();
      } catch (error) {
        if (error instanceof GoogleAuthError) return undefined;
        throw error;
      }
    })();
    const connections = [];
    for (const row of rows) {
      let tokenState = row.sync_status;
      if (row.sync_status === "connected" && config) {
        try {
          const ensured = await ensureAccessToken(db, vault, config, row.id);
          tokenState = ensured.state;
        } catch (error) {
          if (!(error instanceof GoogleAuthError)) throw error;
          tokenState = error.kind === "invalid_grant" ? "needs_reauth" : error.kind;
        }
      }
      connections.push({
        id: row.id, provider: row.provider,
        scopes: z.array(z.string()).parse(JSON.parse(row.scopes_json)),
        status: tokenState, lastSuccessAt: row.last_success_at,
      } satisfies Connection);
    }
    return Response.json({ connections });
  }
  const disconnectMatch = /^\/api\/connections\/([^/]+)$/.exec(path);
  if (disconnectMatch && request.method === "DELETE") {
    const id = disconnectMatch[1];
    if (!id) return Response.json({ error: "invalid_input" }, { status: 422 });
    return disconnect(db, id)
      ? Response.json({ disconnected: true })
      : Response.json({ error: "missing" }, { status: 404 });
  }
  return Response.json({ error: "not_found" }, { status: 404 });
}
