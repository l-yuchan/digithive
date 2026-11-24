# Harness test remediation, 2026-11-24

## Scope and result

Reviewed the 13 original test files against the current application's production
paths. Remediation is limited to `apps/harness`; the older root prototype and
`apps/assistant` were not changed. No deployment or Git commit was performed.

Final command: `cd apps/harness && bun test`.

Result: **120 pass, 0 fail, 407 assertions, 19 files, 1.185 seconds**.
The starting suite had 90 passing tests in 13 files. Counts are execution
evidence, not a quality target. Lint, typecheck, formatting and CI/CD were
explicitly deferred by the owner and were not run or configured.

## Contracts now protected

| Area | Observable protected by the tests | Production correction |
| --- | --- | --- |
| Workspace | Traversal, sibling prefixes and directory symlinks cannot read or overwrite outside files; nested valid paths still work | Check path components and resolved filesystem ancestors |
| Work lifetime | Active work renews its lease; cancellation cannot become success; a killed worker is reconciled; separate workers respect one shared concurrency slot | Heartbeat, ownership fences and immediate SQLite claim/reconciliation transactions |
| Work limits | Total deadline interrupts an unending provider; tool-call budget survives repeated provider IDs; round exhaustion fails | Propagate cancellation, persist call/round counters and stop before the next effect |
| Tool deadlines | Cooperative tools receive cancellation and perform no delayed effect after timeout | Per-call AbortSignal and timer cleanup |
| Approvals | No effect before approval; exactly one effect in the tested successful path; zero on rejection/expiry; repeated decisions fail; cancelled work cannot be resurrected | Transactional decision checks and current-policy re-evaluation |
| Approval batches | Two calls remain pending across separate approval pauses without replaying completed effects | Persist the remaining batch |
| Delegation | Invalid budgets/profiles are rejected; input references and completion instructions survive storage; read-only work cannot edit | Validate fields, retain the contract and apply the permission profile during execution |
| Event delivery | A real HTTP SSE connection receives an event written by a separate process; Last-Event-ID resumes; replay/subscription gaps do not lose events | Drain persisted events with a cursor instead of relying only on process-local listeners |
| Provider protocol | Both conversation and work send assistant tool calls and correctly associated tool results to an HTTP endpoint that validates them | Serialize wire field names and retain assistant tool-call messages |
| Provider streaming | Premature EOF rejects partial output; fragmented UTF-8/CRLF survives; first-response timeout covers waiting for headers | Reject unfinished streams, normalize frame separators and bound the initial request |
| Google collection | All list/history pages are collected; more than 25 Gmail additions survive; failed pages/details preserve the previous snapshot and cursor | Stage collection before an atomic commit; do not skip failed detail requests |
| Full resync | Obsolete Calendar rows are replaced after successful collection; Gmail captures its history baseline before listing | Replace full snapshots only on success |
| Credential refresh | Expired credentials refresh before collection and the replacement is reused | Existing refresh path is now exercised through sync |
| Branch compaction | Editing before the summarized ancestor excludes the abandoned summary; switching back restores its summary | Restrict compaction and summary selection to the active ancestry |
| Persistence | Event sequence and replay survive a real close/reopen; old data survives schema upgrade; failed migration leaves no partial tables | Stronger tests of the existing migration transaction |
| Authentication shell | An unauthenticated request receives the actual HTML shell with HTTP 200, rather than accepting a missing build's 404 | Replace the weak test fixture |

Work execution, lease management and tool execution are separated into
`src/surfaces/work/execution.ts`, `lease.ts` and `tool.ts`; queue and approval
operations remain in `runner.ts`.

## Failure evidence

The new regression tests first exposed the existing implementations:

- Workspace confinement: 1 failure, 1 pass.
- Work lifecycle/limits: 5 failures, 2 passes.
- Cross-process SSE: no event delivered before the bounded watchdog.
- Sync pagination/cursor safety: 6 failures.
- Branch compaction: edited branch retained the abandoned summary.
- Cancelled approval: approving the pending request did not throw and requeued work.
- Provider stream boundaries: 3 failures, 8 passes.

Two additional mutations proved that green tests were sensitive to their owners:

1. Changed `tool_call_id` back to `toolCallId`: the HTTP tool round-trip failed
   with a failed run instead of success.
2. Removed the migration transaction wrapper: the rollback test found a partial
   `memories` table after the intentional SQL collision.

The mutation run had **5 pass, 2 fail**. Both mutations were restored before the
final full-suite run. `src/store/db.ts` has no remaining content change.

## Test cleanup

Removed six tests whose targets had no production callers, together with those
unused implementations:

- Two `syncSource` tests. Actual Calendar/Gmail sync now owns stored cursor,
  snapshot, error-state and emitted-event assertions.
- Four tests of `nextBriefingAt`, `briefingRunRequest` and `sendBriefingPush`.
  Runtime scheduling uses `dueSlot`/`runBriefing`, and delivery uses `sendPush`;
  their existing tests remain.

This is removal of unused parallel implementations, not a claim that the two
scheduling APIs had identical semantics. The runtime constants remain.

Retained primitive and transport tests when they protect different boundaries.
Replaced the falsely named reopen test with a real disk reopen. Improved the
shell fixture and foreign-key assertion, corrected branch fixtures to construct
actual parent chains, and cleaned up worker test databases/directories.

## Limits and remaining findings

- The monetary field `maxMicroUsd` is validated and retained but **is not an
  enforced spending cap**. The code has no model-pricing/reservation ledger.
  Only tool-call and execution limits are claimed as enforced here. Pricing
  and accounting require a separate product contract, not a guessed test value.
- Completion conditions and input references are supplied as model instructions.
  These tests do not prove semantic completion or that referenced content was
  retrieved.
- Cancellation can stop cooperative tools. It cannot undo an already committed
  external effect or stop arbitrary code that ignores its signal. The approval
  tests do not establish crash-safe exactly-once delivery to an external service.
- Filesystem checks reject the tested static symlink/traversal cases; they are
  not a hardened sandbox against a separate hostile process swapping symlinks
  between a check and an I/O operation.
- Tests ran on this Windows workstation, with real local HTTP, SQLite files,
  separate Bun processes and synthetic external responses. No paid model calls,
  live Google/Canvas account requests or real push delivery were made. Linux
  containers and production UI were not exercised during this change.
- The TypeScript language server is unavailable. No dependency was installed;
  typecheck remains deferred as requested. Runtime tests are not a typecheck.

This was a direct self-review. No independent reviewer was used.
