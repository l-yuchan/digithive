# Task 4 evidence

Runs are enqueued with a unique request key: a repeated `client_request_id`
returns the same Run id (verified over real HTTP, 202 both times, same id).
An attempt moves queued -> claimed -> running -> terminal under
`BEGIN IMMEDIATE`, carrying a monotonically increasing fence and a 30-second
lease. Only the attempt whose fence matches `runs.next_fence - 1`, whose
worker still holds the lease, and whose Run is still running may persist a
completion. Cancellation is a CAS update: it wins outright, bumps the fence,
and a later stale completion throws `RunConflict`.

Expired leases are recovered explicitly: the attempt becomes `interrupted`,
consumed tool calls become `outcome_unknown` (never silently `failed` or
retried), the Run becomes `interrupted`, and no new worker claims it. An
approval wait persists the exact planned tool call and args, releases the
lease and leaves `awaiting_approval`, so the process is not held.

Verification: `bun run verify` = strict typecheck, bundle (3 entrypoints) and
11 tests. Mutation proofs each went red on the intended assertion and were
restored byte for byte: removing the stale-fence throw, skipping the request
key lookup, and recording `failed` instead of `outcome_unknown`.

Real-surface QA:
- `run-reconnect`: actual HTTP enqueue, a separate worker process (exit 0),
  `GET /api/runs/:id` returning `succeeded`, and an SSE stream that contains
  exactly one `succeeded` event; reconnecting with `after=1` yields one event,
  not a duplicate. See `events.json`, `http.json`.
- `run-lease-crash-cancel`: two worker processes competed, exactly one claimed;
  the lease holder was killed (`exit 143`), its completion was rejected, a
  second worker could not take over the interrupted Run, and cancel beat a
  concurrent completion. `staleWrites: 0`. See `db-diff.json`,
  `process-cleanup.json`.

Adversarial classes probed: duplicate submission (single Run), crash/cancel
race (one terminal result, zero stale writes), stale state (expired lease and
post-cancel writes rejected), dirty worktree (isolated worktree, explicit
paths), long-running commands (worker bounded by an explicit kill timer),
misleading success (assertions read HTTP body, DB rows and event stream, not
stdout). External-source prompt injection, untrusted input parsing and
repeated interrupts belong to the agent/executor tasks and are not present
in this runtime-only surface.

Cleanup: QA server and fixture ports rebound, temporary databases removed,
both spawn processes reaped (`temporaryRemoved: true`).

Known limits: the worker recognises a `sha256` executor only; script and agent
executors arrive in Tasks 6 and 7, and until then an unregistered executor
fails the Run instead of pretending success. There is no approval-decision
endpoint yet (Task 21); this task only persists the awaiting state and the
resume transaction contract.
