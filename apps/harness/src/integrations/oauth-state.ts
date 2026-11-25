import type { Database, SQLQueryBindings } from "bun:sqlite";

export const OAUTH_STATE_TTL_MS = 10 * 60_000;

/** A random, persisted, single-use OAuth challenge with an optional reconnect target. */
export function createOAuthState(db: Database, accountId: string | null, now = Date.now()): string {
  const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  db.query("DELETE FROM oauth_states WHERE expires_at <= ?").run(new Date(now).toISOString());
  db.query("INSERT INTO oauth_states(state,account_id,expires_at,created_at) VALUES (?,?,?,?)").run(
    state,
    accountId,
    new Date(now + OAUTH_STATE_TTL_MS).toISOString(),
    new Date(now).toISOString(),
  );
  return state;
}

export type OAuthStateResult =
  | { readonly ok: true; readonly accountId: string | null }
  | { readonly ok: false; readonly reason: "invalid" | "expired" };

/** Consumes the challenge exactly once; a replay or an expired challenge fails. */
export function consumeOAuthState(db: Database, state: string, now = Date.now()): OAuthStateResult {
  const run = db.transaction((): OAuthStateResult => {
    const row = db
      .query<{ account_id: string | null; expires_at: string }, SQLQueryBindings[]>(
        "SELECT account_id,expires_at FROM oauth_states WHERE state = ?",
      )
      .get(state);
    if (!row) return { ok: false, reason: "invalid" };
    db.query("DELETE FROM oauth_states WHERE state = ?").run(state);
    if (Date.parse(row.expires_at) <= now) return { ok: false, reason: "expired" };
    return { ok: true, accountId: row.account_id };
  });
  return run();
}
