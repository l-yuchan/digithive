# Task 1 evidence

The new package was built in the isolated W1 worktree. `bun install` exited 0
and created `apps/assistant/bun.lock`. The exact acceptance chain `bun run
typecheck && bun run build && bun run doctor -- --mode local --json` exited 0;
the JSON response is in `../../evidence/digithive-v2/task-1/doctor.json`.
The missing-live-config invocation exited 1 with `NEEDS_SETUP`, 15 missing
requirements and zero external requests; see `missing.json`.

The `doctor` command gives a real filesystem write, loopback port, executable,
lockfile and settings check. The local READY result does not assert Docker or
Linux readiness. Canvas CLI on this workstation is a Windows binary, and
Docker is unavailable. Provider tool calling, search pricing, OAuth consent
and push delivery remain unverified by the preflight, so live doctor cannot
pass until their later integration checks are implemented.

Applicable adversarial checks: invalid mode returns an error and exit 1;
the separately clean worktree preserved the user's main-checkout files;
external executables have a two-second timeout; missing live capabilities
produce a nonzero result rather than a false PASS. Prompt injection,
cancel/resume, stale artifacts and interruption do not apply to this
preflight-only CLI. The temporary write probe was removed in a `finally`,
the listening socket was closed, and the process exited. No server, browser,
container or external request was started.
