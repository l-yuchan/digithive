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
