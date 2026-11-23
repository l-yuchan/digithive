# Task 3 evidence

The app now rejects startup without an origin, passphrase hash, session key
and encryption key; that command exited 1 before binding a port. Server-side
sessions store an HMAC digest of a random opaque token. The browser receives
an HttpOnly, SameSite cookie, Secure under HTTPS. Mutations require the exact
Origin and Host including port, and an expired session cannot authenticate.
Five incorrect logins lead to HTTP 429. Secrets use AES-256-GCM and reject
changed ciphertext. The policy boundary checks consented source scopes and
active approved tool versions, and denies external writes and environment
changes by default. API dispatch uses its authenticated-session branch;
future source and tool routes must provide their requested scope.

`bun run verify` includes four authentication tests; each security owner
was temporarily broken and the relevant test went red (Origin accepted,
expired session accepted, ciphertext authentication removed, unconsented
source scope accepted). All mutations
were restored. `bun run qa --scenario auth-origin-and-expiry` exercised the
real HTTP boundary: 403 for an evil Origin, 401 after expiry, then 429 after
five incorrect logins. Its response-body check ensures the opaque token is
not returned in JSON. See `auth-http.json`.

The owned browser used the exact `data-testid` login selectors, then showed
the authenticated page; the page explicitly notes that the conversation UI
comes in a later task. After logout, the login form returned. Fresh desktop
and phone captures show readable content and zero horizontal overflow at
390 CSS pixels. The browser, QA profile, server and temporary database were
removed; `actions.json` records the steps.

Applicable adversarial checks: malformed JSON yields 422; wrong Origin and
Host are rejected; expired sessions do not authorize; login throttling
holds across repeated requests; altered ciphertext cannot decrypt. Browser
output has no token or passphrase in the page. Stale screenshots from an
initial wrong-size mobile emulation were replaced after pinning the viewport.
Generated-code sandbox, worker cancellation and external-source prompt
injection do not enter this authentication-only task.
