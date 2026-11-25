import type { Database, SQLQueryBindings } from "bun:sqlite";
import { getAccount, ensureAccountSources } from "./account-store";

export type GoogleIdentity = {
  readonly subject: string;
  readonly email: string | null;
  readonly label?: string;
};

export type UpsertResult = { readonly id: string; readonly created: boolean };

/**
 * Binds a verified Google identity to an account. An existing subject is reused,
 * and the seeded legacy account is adopted only when the verified email matches
 * exactly one unbound legacy row. Order of accounts is never used as identity.
 */
export function upsertGoogleAccount(db: Database, identity: GoogleIdentity): UpsertResult {
  const now = new Date().toISOString();
  const run = db.transaction((): UpsertResult => {
    const same = db
      .query<{ id: string }, SQLQueryBindings[]>(
        "SELECT id FROM integration_accounts WHERE provider = 'google' AND subject = ?",
      )
      .get(identity.subject);
    if (same) {
      if (identity.email) {
        db.query(
          "UPDATE integration_accounts SET email = COALESCE(?, email), updated_at = ? WHERE id = ?",
        ).run(identity.email, now, same.id);
      }
      ensureAccountSources(db, same.id, "google");
      return { id: same.id, created: false };
    }

    if (identity.email) {
      const candidates = db
        .query<{ id: string }, SQLQueryBindings[]>(
          "SELECT id FROM integration_accounts WHERE provider = 'google' AND subject IS NULL AND email IS NOT NULL AND lower(email) = lower(?)",
        )
        .all(identity.email);
      const legacy = candidates.length === 1 ? candidates[0] : undefined;
      if (legacy) {
        db.query(
          "UPDATE integration_accounts SET subject = ?, email = ?, updated_at = ? WHERE id = ? AND subject IS NULL",
        ).run(identity.subject, identity.email, now, legacy.id);
        ensureAccountSources(db, legacy.id, "google");
        return { id: legacy.id, created: false };
      }
    }

    const id = crypto.randomUUID();
    const label = identity.label ?? identity.email ?? "Google 계정";
    db.query(
      "INSERT INTO integration_accounts(id,provider,subject,email,label,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    ).run(id, "google", identity.subject, identity.email, label, now, now);
    ensureAccountSources(db, id, "google");
    return { id, created: true };
  });
  return run();
}

export function deleteAccount(db: Database, id: string): boolean {
  const result = db.query("DELETE FROM integration_accounts WHERE id = ?").run(id);
  return result.changes > 0;
}

export type BindResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "identity_mismatch" | "identity_unverified" | "subject_conflict";
    };

/** Binds a verified identity to an existing account; never rebinds a different one. */
export function bindGoogleIdentity(
  db: Database,
  accountId: string,
  identity: GoogleIdentity,
): BindResult {
  const account = getAccount(db, accountId);
  if (!account || account.provider !== "google") {
    return { ok: false, reason: "identity_mismatch" };
  }
  if (account.subject) {
    return account.subject === identity.subject
      ? { ok: true }
      : { ok: false, reason: "identity_mismatch" };
  }
  const hasCredential =
    db.query("SELECT account_id FROM oauth_tokens WHERE account_id=?").get(accountId) !== null;
  if (hasCredential && (!account.email || !identity.email)) {
    return { ok: false, reason: "identity_unverified" };
  }
  if (account.email && account.email.toLowerCase() !== identity.email?.toLowerCase()) {
    return { ok: false, reason: "identity_mismatch" };
  }
  const other = db
    .query<{ id: string }, SQLQueryBindings[]>(
      "SELECT id FROM integration_accounts WHERE provider = 'google' AND subject = ? AND id <> ?",
    )
    .get(identity.subject, accountId);
  if (other) return { ok: false, reason: "subject_conflict" };
  db.query(
    "UPDATE integration_accounts SET subject = ?, email = COALESCE(?, email), updated_at = ? WHERE id = ?",
  ).run(identity.subject, identity.email, new Date().toISOString(), accountId);
  ensureAccountSources(db, accountId, "google");
  return { ok: true };
}
