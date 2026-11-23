# Task 11 evidence

The Google connection is a real OAuth web-server flow: read-only Calendar and
Gmail scopes, `access_type=offline` with `prompt=consent` so a refresh token is
issued, PKCE S256, and an exact redirect URI. Pending authorizations are stored
server-side with their verifier and are single-use and short-lived: a forged
state, a state from another provider or a state older than ten minutes is
refused with 403, and replaying a used state is refused too.

Tokens never leave the server. The access and refresh tokens are AES-256-GCM
encrypted into `connections.credential_ciphertext`, connection listings expose
only provider, scopes and a coarse status, and no response body or log carries a
token. A reconnect that omits the refresh token (Google only returns it on the
first consent) keeps the stored one instead of erasing it, and a refresh that
Google rejects with `invalid_grant` marks the connection `needs_reauth` rather
than handing back a dead token. Concurrent callers share one refresh.

Verification: `bun run verify` includes six OAuth tests (authorization URL
parameters, single-use state with provider and expiry checks, refresh-token
preservation, single-flight refresh, rejected refresh, refused code exchange).

Real HTTP QA against the live app with a local OAuth token fixture:
- `oauth-code-refresh`: `GET /api/oauth/google/start` returned 302 with
  `access_type=offline`, `prompt=consent`, `code_challenge_method=S256` and the
  exact redirect; the callback (303) exchanged the code with a PKCE verifier;
  `GET /api/connections` reported `valid`. Expiring the stored token triggered
  exactly one `refresh_token` grant and the connection returned to `valid`.
  See `redacted-http.json`.
- `oauth-state-revocation`: forged state 403, replayed state 403, a
  `invalid_grant` refresh moved the connection to `needs_reauth`, and the
  connection listing and authorization redirect contained neither the client
  secret nor a token. See `failures.json`.

The user pointed at the existing GWS registration: the workstation has a Google
Cloud project `apis-502710` whose installed-app client secret lives at
`~/.config/gws/client_secret.json`. `GOOGLE_CLIENT_SECRET_FILE` now accepts that
file directly (server-side only; the file is never copied into the repository),
and the redirect URI defaults to `APP_ORIGIN/api/oauth/google/callback`.
Constraint recorded for deployment: an *installed* client only allows loopback
redirects, so either register a *Web application* client for the HTTPS origin or
run the consent step through a loopback tunnel. Live consent has not been
performed, so no real Google token exists yet; that remains the Task 25
`NEEDS_SETUP` item unless the user completes the consent step.

Adversarial classes probed: forged/replayed/expired state, mismatched provider,
reused code, rejected refresh, token leakage in responses, stale token after
revocation. Cleanup: QA ports rebound, temporary DB removed (`cleanup.json`).

Known limits: no real account was authorized in this task, so scope-grant
content, consent-screen status and long-term refresh behaviour on the deployed
host are unverified; Calendar and Gmail reading is Task 12/13.
