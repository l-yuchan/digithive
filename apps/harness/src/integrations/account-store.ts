import type { Database, SQLQueryBindings } from "bun:sqlite";

/** Fixed identities seeded by migration v6, so legacy data always has an owner. */
export const DEFAULT_GOOGLE_ACCOUNT_ID = "google-default";
export const DEFAULT_CANVAS_ACCOUNT_ID = "canvas-default";

export type Provider = "google" | "canvas";
export type SourceName = "calendar" | "gmail" | "canvas";

export type AccountRecord = {
  readonly id: string;
  readonly provider: Provider;
  readonly subject: string | null;
  readonly email: string | null;
  readonly label: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type SourceSummary = {
  readonly source: SourceName;
  readonly enabled: boolean;
  readonly ok: boolean;
  readonly cursor: string | null;
  readonly lastSyncAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly error: string | null;
};

export type AccountSummary = AccountRecord & {
  readonly connected: boolean;
  readonly sources: readonly SourceSummary[];
};

type AccountRow = {
  id: string;
  provider: string;
  subject: string | null;
  email: string | null;
  label: string;
  created_at: string;
  updated_at: string;
};

type SourceRow = {
  account_id: string;
  source: string;
  enabled: number;
  cursor: string | null;
  last_sync_at: string | null;
  last_attempt_at: string | null;
  ok: number;
  error: string | null;
};

function toAccount(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    provider: row.provider === "canvas" ? "canvas" : "google",
    subject: row.subject,
    email: row.email,
    label: row.label,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSource(row: SourceRow): SourceSummary {
  return {
    source: row.source === "canvas" ? "canvas" : row.source === "gmail" ? "gmail" : "calendar",
    enabled: row.enabled === 1,
    ok: row.ok === 1,
    cursor: row.cursor,
    lastSyncAt: row.last_sync_at,
    lastAttemptAt: row.last_attempt_at,
    error: row.error,
  };
}

export function getAccount(db: Database, id: string): AccountRecord | null {
  const row = db
    .query<AccountRow, SQLQueryBindings[]>(
      "SELECT id,provider,subject,email,label,created_at,updated_at FROM integration_accounts WHERE id = ?",
    )
    .get(id);
  return row ? toAccount(row) : null;
}

export function listAccountRecords(db: Database): AccountRecord[] {
  return db
    .query<AccountRow, SQLQueryBindings[]>(
      "SELECT id,provider,subject,email,label,created_at,updated_at FROM integration_accounts ORDER BY provider, created_at, id",
    )
    .all()
    .map(toAccount);
}

export function accountSources(db: Database, accountId: string): SourceSummary[] {
  return db
    .query<SourceRow, SQLQueryBindings[]>(
      "SELECT * FROM account_sources WHERE account_id = ? ORDER BY source",
    )
    .all(accountId)
    .map(toSource);
}

export function getSource(
  db: Database,
  accountId: string,
  source: SourceName,
): SourceSummary | null {
  const row = db
    .query<SourceRow, SQLQueryBindings[]>(
      "SELECT * FROM account_sources WHERE account_id = ? AND source = ?",
    )
    .get(accountId, source);
  return row ? toSource(row) : null;
}

export function sourcesForProvider(provider: Provider): readonly SourceName[] {
  return provider === "google" ? ["calendar", "gmail"] : ["canvas"];
}

export function ensureAccountSources(db: Database, accountId: string, provider: Provider): void {
  const insert = db.query("INSERT OR IGNORE INTO account_sources(account_id,source) VALUES (?,?)");
  for (const source of sourcesForProvider(provider)) insert.run(accountId, source);
}

/** A source without a row is not enabled; the seeds give every real source a row. */
export function isSourceEnabled(db: Database, accountId: string, source: SourceName): boolean {
  const row = db
    .query<{ enabled: number }, SQLQueryBindings[]>(
      "SELECT enabled FROM account_sources WHERE account_id = ? AND source = ?",
    )
    .get(accountId, source);
  return row?.enabled === 1;
}

export function setSourceEnabled(
  db: Database,
  accountId: string,
  source: SourceName,
  enabled: boolean,
): SourceSummary | null {
  const account = getAccount(db, accountId);
  if (!account) return null;
  if (!sourcesForProvider(account.provider).includes(source)) return null;
  db.query("INSERT OR IGNORE INTO account_sources(account_id,source) VALUES (?,?)").run(
    accountId,
    source,
  );
  db.query("UPDATE account_sources SET enabled = ? WHERE account_id = ? AND source = ?").run(
    enabled ? 1 : 0,
    accountId,
    source,
  );
  return getSource(db, accountId, source);
}

/** Connected means a usable credential exists, never merely that the seed row exists. */
export function listAccounts(
  db: Database,
  options: { readonly canvasConfigured?: boolean } = {},
): AccountSummary[] {
  const accounts = db
    .query<AccountRow, SQLQueryBindings[]>(
      "SELECT id,provider,subject,email,label,created_at,updated_at FROM integration_accounts ORDER BY provider, created_at, id",
    )
    .all();
  const tokens = new Set(
    db
      .query<{ account_id: string }, SQLQueryBindings[]>("SELECT account_id FROM oauth_tokens")
      .all()
      .map((row) => row.account_id),
  );
  return accounts.map((row) => {
    const account = toAccount(row);
    const connected =
      account.provider === "google" ? tokens.has(account.id) : options.canvasConfigured === true;
    return { ...account, connected, sources: accountSources(db, account.id) };
  });
}

/** Google identities that hold a credential and still have this source enabled. */
export function enabledGoogleAccounts(
  db: Database,
  source: Extract<SourceName, "calendar" | "gmail">,
): AccountRecord[] {
  return db
    .query<AccountRow, SQLQueryBindings[]>(
      `SELECT a.id,a.provider,a.subject,a.email,a.label,a.created_at,a.updated_at
       FROM integration_accounts a
       JOIN oauth_tokens t ON t.account_id = a.id
       JOIN account_sources s ON s.account_id = a.id AND s.source = ?
       WHERE a.provider = 'google' AND s.enabled = 1
       ORDER BY a.created_at, a.id`,
    )
    .all(source)
    .map(toAccount);
}

export function applyAccountEmail(db: Database, accountId: string, email: string): boolean {
  const result = db
    .query(
      "UPDATE integration_accounts SET email = ?, updated_at = ? WHERE id = ? AND (email IS NULL OR email = ?)",
    )
    .run(email, new Date().toISOString(), accountId, email);
  return result.changes > 0;
}
