# Task 14 evidence

The LMS collector drives the official `canvas` CLI and never speaks to the LMS
over an ad-hoc HTTP client. Only one argv shape can be built: `api GET
/api/v1/...` with `--paginate -o json --no-cache`. Arbitrary subcommands,
absolute or traversal paths, shell metacharacters and write verbs are refused
before any process starts, and `--as-user`, `--token` and debug/verbose flags are
on a deny list, so a token can never be appended to argv. The host is pinned via
`CANVAS_HOST` and course ids are checked against `CANVAS_COURSES`, so a link or a
record pointing at another course (or another host's URL) is never followed.

Exit status is mapped to typed failures (`auth_required`, `forbidden`,
`not_found`, `invalid_json`, `cli_failed`); a CLI envelope carrying a 4xx is
mapped the same way. Courses, assignments and announcements are stored as source
items with content hashes, so an unchanged assignment writes nothing. A missing
assignment becomes a tombstone only after a complete, successful list, which is
what prevents a permission error or a partial read from looking like "the course
deleted this assignment".

Verification: `bun run verify` = typecheck, bundle, 67 tests. Five Canvas tests
cover argv building and refusals, a merged two-page assignment list with another
course's item filtered out, a missing binary and a failed exit as typed errors,
401/broken-JSON envelopes, and the tombstone rule across failed and complete-empty
lists.

Real-surface QA on this workstation (the installed `canvas-cli 1.15.8` really
executed for the status probe; list transport was a fixture child process so no
course data or credential was touched):
- `canvas-cli-pages`: `cliStatus` returned `ok: true`, `canvas-cli 1.15.8`; the
  sync stored 3 assignments (including the item that only arrives on the second
  page), one allowlisted course and one announcement, and dropped the
  non-allowlisted course. Due dates and requirement text round-tripped exactly.
  See `items.json`, `argv-redacted.json`.
- `canvas-auth-partial-host`: 401 → `auth_required`, 403 → `forbidden`, 404 →
  `not_found`, malformed JSON → `invalid_json`, and a response describing another
  host → `forbidden`. Tombstones stayed at 0 and a course outside the allowlist
  was refused. See `failures.json`.

Migration defect found while writing this: the first implementation spawned a
`.cmd` shim that cmd.exe re-parsed (an `&` inside the query string split the
command), so the collector now takes an injectable spawn surface and the QA uses
a fixture child process instead of a shell shim; the real installed CLI is still
exercised for its version contract. `kill()` on timeout and an 8 MiB output cap
are enforced on every invocation.

Adversarial classes probed: unexpected 4xx, malformed JSON, missing executable,
foreign course/host, shell-injection-shaped path, write verb, false deletion.
Cleanup: fixture processes exit, temporary connection rows are in the QA
database only, QA ports and the temporary DB are removed (`cleanup.json`).

Known limits: the real Hanyang LMS has not been queried, so authentication state,
actual course ids and submission-like endpoints remain unverified until the user
provides `CANVAS_COURSES`/credentials at Task 25; page-walking is delegated to
the official CLI's `--paginate`, whose `Link rel=next` handling is its own
contract, and no submission or write path is implemented at all.
