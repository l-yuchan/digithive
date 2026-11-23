# Task 2 evidence

The new SQLite schema is applied by numbered migration in an immediate
transaction. `bun run verify` checks the server bundle, strict types and
three migration tests. The rollback test failed when transaction ownership
was temporarily removed: the expected `"before"` value became `"after"`.
The unique test failed when the `(connection_id,remote_id)` index was
temporarily changed. The foreign-key test failed when its connection
reference was temporarily removed. Each owner was restored before the final
verification.

`bun run qa --scenario foundation-health --evidence
../../.omo/evidence/digithive-v2/task-2` returned an actual HTTP 200 at
127.0.0.1:4317 with schema version 1. The DB evidence records foreign keys 1,
WAL and synchronous 2 (FULL). `foundation-bad-migration` preserved the
existing row and schema version 1 after SQL failure. `nonexistent` exited 2;
the intentionally invalid fixture response exited 1. The cleanup receipt
shows both fixed ports bindable again and the private temporary DB removed.

Applicable adversarial checks: malformed scenario and fixture response
produce distinct nonzero exits; an invalid migration cannot leave a partial
update; the QA directory is isolated from the prototype; the fixed QA
ports are never replaced by a random port or killed if already occupied;
success comes from HTTP response and DB assertions, not process stdout.
There is no external untrusted text or resumable workflow in this
foundation-only scenario. A long-running provider call and interrupted
attempt are deferred to the plan tasks that introduce them.
