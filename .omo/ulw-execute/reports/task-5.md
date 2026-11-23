# Task 5 evidence

Cost accounting is integer micro-USD on UTC-stored instants grouped into a
calendar month by the configured IANA timezone (`Asia/Seoul` by default). Every
paid call reserves a maximum estimate inside a `BEGIN IMMEDIATE` transaction
that first sums that month's `settled + active_reservations + unknown
liabilities`; a reservation that would cross the limit is refused with
`limit_exceeded` and nothing is written. A provider request id is unique, so a
retried call returns the original reservation instead of double-booking.

Settlement never turns an unknown charge into free cost: a missing usage
record settles to `unknown`, keeps the reserved amount as a liability, and
records the null observation in `usage_ledger`. Settling twice is refused. A
provider price version that is not configured blocks the reservation entirely
(`price_unknown`), so unconfigured pricing cannot trigger a paid call.

Settings are stored with a revision. An update binds to the revision the
client read; a stale revision is refused (409 over HTTP) instead of silently
overwriting. Automation cannot be enabled until the user confirmation flag is
set, and settings payloads cannot carry a plaintext secret. The 70/90/100 USD
values are returned as labelled *proposals*, not as applied policy.

Verification: `bun run verify` = strict typecheck, bundle, 19 tests. Mutation
proof: replacing the limit comparison with `if (false)` turned the concurrent
limit test red on its `assert.throws` and was restored byte for byte.

Real-surface QA:
- `budget-settle`: two real reservations settled at 150,000 and 250,000
  micro-USD; `GET /api/usage` returned settled 400,000, reserved 0, unknown 0,
  `priceVersions: ["price-v1"]`, proposal thresholds 70/90/100 USD.
  See `usage.json`.
- `budget-concurrent-unknown`: two separate OS processes raced for the last
  100,000 micro-USD of a 100 USD month. Exactly one reservation was accepted,
  the other received `limit_exceeded`; committed stayed 100,000,000. The
  winner's missing usage became a 100,000 unknown liability rather than zero.
  Month boundary 2026-11 for `2026-10-31T16:00:00Z` in Asia/Seoul, and the
  next month's commitment is 0 with no duplicate settlement. See `ledger.json`.

Adversarial classes probed: concurrent reservation across processes (one
accepted, one refused), stale state (replayed provider request id, double
settle refused), missing data (unknown liability retained), malformed settings
(secret key and stale revision refused, unconfirmed enable refused), timezone
boundary, and dirty worktree (isolated worktree, explicit staged paths).
Prompt injection, cancellation and long external calls are not reachable from
this accounting-only surface; they were exercised in Task 4.

Cleanup: QA ports rebound, temporary databases removed, both child processes
reaped (`cleanup.json`).

Known limits: no paid provider call exists yet, so no real provider invoice has
been reconciled; Task 7 attaches the reservation/settlement calls to the model
adapter and Task 17/19 consume the threshold policy. Settings secrets are a
write-only reference by contract; the actual secret store is exercised in
Task 3's vault and Task 11/24's injection path.
