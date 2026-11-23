# Task 6 evidence

Approved scripts run only inside a real Docker sandbox on the deployment host
(`mini`, Docker 29.6.1). The web/worker process holds no Docker socket: it
calls a separate runner over an authenticated HTTP endpoint. The runner
accepts a strict schema (image allowlisted by prefix, `main.ts` entrypoint,
argv array, timeout/output/memory/CPU/PID limits), runs the container detached
and enforces the deadline itself instead of trusting the attached CLI.

Sandbox hardening actually applied to every run, verified from the container:
`--network none`, `--read-only` rootfs, `--tmpfs /tmp:rw,noexec,nosuid,16m`,
`--cap-drop ALL`, `no-new-privileges`, `--pids-limit 32`, `--memory 128m`,
`--cpus 0.5`, `--user 65534:65534`, `--ulimit nofile=64`, input mounted
read-only at `/in`, only the per-run `/out` directory writable, and no DB,
credential, host source or Docker-socket mount inside the sandbox.

Decision gate: a generated script runs only when its `artifact_digest` is the
active, user-approved `tool_versions` row. An unapproved digest is rejected
before any runner call. A collector script (shipped with the app) uses the same
runner without that gate. Missing runner configuration fails closed with
`sandbox_unavailable`; no local fallback exists.

Real-surface QA (against the mini over an SSH tunnel, not a mock):
- `script-approved`: the approved transform script read its read-only input,
  wrote `/out/result.txt` (14 bytes, sha256
  `439c264e90d0afc41b7c8515b9aae30f9637bb58585bd37902813384b7e64ef5`) and
  printed `TRANSFORMED 13`. An unapproved digest was refused.
  See `result.json`, `transcript.txt`.
- `script-escape-and-timeout`: inside the sandbox the process ran as uid
  65534; reading `/etc/shadow` was blocked, `fetch("https://example.com")` was
  blocked by `--network none`, and writing `/root/probe` was blocked by the
  read-only rootfs. An unbounded `while (true)` script was killed after a 5 s
  limit in 6 s wall time and the Run reported `timedOut: true`, leaving no
  container behind. See `sandbox.json`, `host.json`.
- Host integrity: the canary file `/tmp/dg-qa/work/host-canary.txt` had an
  identical sha256 before and after all runs (`host.json`).

Bugs found and fixed by this QA, each re-verified: the runner did not create
its `runs/` directory; bind sources were resolved with the runner's view of the
volume instead of the daemon's (`SANDBOX_HOST_ROOT`); the output directory was
root-owned so the non-root sandbox could not write it; the image's baked
ENTRYPOINT duplicated argv (`process.argv` contained `bun /in/main.ts` twice);
and the first timeout implementation relied on the attached `docker run` CLI
process, which did not forward termination, leaving spinning containers. Two
such leftover containers were removed explicitly and the current build leaves
none (`teardown.json`).

Adversarial classes probed: escape attempts (secret read, network, rootfs
write), unbounded CPU (timeout), argv injection (a value containing `; rm -rf
/` stays one argv element, no shell), approval bypass (unapproved digest
refused before the runner call), missing sandbox (fail closed), stale state
(old containers cleaned), dirty worktree (isolated worktree, explicit paths).

Cleanup: runner container, both images and `/tmp/dg-qa` removed; 20 unrelated
containers preserved; tunnel closed. See `teardown.json`.

Known limits: the runner-to-sandbox path is proven here directly against
Docker, but the deployed worker calling the runner through compose networking
is wired and re-verified at Task 24. Scripts are limited to a single `main.ts`
entrypoint per request; multi-file artifacts need the approved image build in
Task 22.
