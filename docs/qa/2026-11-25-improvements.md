# Runtime, accounts and execution visibility

Implementation order and contracts:

1. Preserve provider failure details before routing. Treat quota, authentication,
   transient transport/service failure and invalid requests separately. Retry only
   before observable output; never replay a partially emitted response or tool call.
   Keep a viable provider for the conversation context. Transient fallback is for
   one call, while quota/auth failures suspend the unhealthy route for a cooldown.
   All routes exhausted is an explicit failed run, never an empty successful answer.
2. Persist errors as message parts as well as run results and events. Show
   compaction failures, provider diagnostics and routing decisions to the owner.
3. Account feature switches govern access to credentials and stored information.
   Collection is a builtin schedule with an explicit account and selected sources.
   Permission applies equally to collection, cached searches and briefings.
4. Display each schedule's executor, inputs and ordered actions. Script execution
   displays its path and arguments; agent execution displays its instructions.
5. Replace the work composer with searchable execution history and full event and
   result inspection. Keep approval and cancellation controls.
6. Migrate the seeded Google identity into the normal account model while keeping
   tokens, collected records and schedule references intact.

Proof uses local HTTP provider fixtures, a populated migration fixture, normal
schedule dispatch, and desktop/mobile browser interactions against the running
application. Provider tests must cover quota, transient failure, exhaustion,
cancellation, partial output and context affinity. Account tests must cover denied
cached data and collection, scoped sources and migration preservation. Existing
lint, formatting, typecheck, tests and web build remain the final checks.

Evidence: `.omo/evidence/2026-11-25-improvements/`.
The append-only run notepad is `/tmp/ulw-20261125-140649.cesiu7.md`.
