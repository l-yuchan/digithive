import { DEFAULT_GOOGLE_ACCOUNT_ID } from "../integrations/account-store";

/**
 * The seeded Google row was a placeholder with a legacy label and an implicit
 * identity. It becomes an ordinary account row: internal ids are not labels, and
 * the account's label is the same scheme every added account gets. The verified
 * subject itself is bound by the OAuth callback (hydrating the mailbox profile
 * first), so a reconnect never forks the data into a second account.
 * `google-default` remains only as the fallback owner of pre-account data
 * (DEFAULT_GOOGLE_ACCOUNT_ID), never as a different kind of account.
 */
export const IDENTITY_MIGRATION = `
UPDATE integration_accounts
   SET label = COALESCE(NULLIF(email, ''), 'Google 계정'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE id = 'google-default' AND label = '기존 Google';
`;

/**
 * v9 — the placeholder id becomes an ordinary generated one, like every account
 * added later. Rows that named it move with it in the same transaction: the
 * credential, the source cursors, the collected items, a pending consent and the
 * schedules scoped to the account. Foreign keys are deferred so the parent row can
 * be renamed after its children without a transient orphan.
 */
export const LEGACY_GOOGLE_ACCOUNT_RENAME = `
PRAGMA defer_foreign_keys = ON;
UPDATE account_sources SET account_id = '${DEFAULT_GOOGLE_ACCOUNT_ID}' WHERE account_id = 'google-default';
UPDATE oauth_tokens SET account_id = '${DEFAULT_GOOGLE_ACCOUNT_ID}' WHERE account_id = 'google-default';
UPDATE oauth_states SET account_id = '${DEFAULT_GOOGLE_ACCOUNT_ID}' WHERE account_id = 'google-default';
UPDATE sync_items SET account_id = '${DEFAULT_GOOGLE_ACCOUNT_ID}' WHERE account_id = 'google-default';
UPDATE schedules
   SET executor_json = json_set(executor_json, '$.accountId', '${DEFAULT_GOOGLE_ACCOUNT_ID}'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE json_extract(executor_json, '$.accountId') = 'google-default';
UPDATE integration_accounts
   SET id = '${DEFAULT_GOOGLE_ACCOUNT_ID}',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE id = 'google-default';
`;
