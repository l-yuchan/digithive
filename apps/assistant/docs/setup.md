# Assistant setup (foundation)

The assistant lives in `apps/assistant` and does not read the prototype database.
Install pinned dependencies with `bun install --frozen-lockfile`. Run
`bun run typecheck`, `bun run build`, and `bun run doctor -- --mode local --json`
from this directory. Doctor checks the Bun runtime, a writable data boundary,
loopback port 4317, and the lockfile. It reports optional Docker and Canvas
availability without making network requests or printing secrets.

`bun run doctor -- --mode live --json` requires a Linux deployment host, Docker,
Canvas CLI, and configured origin, passphrase hash, session and encryption
keys, Google OAuth credentials, Web Push key, model provider, and search key.
It reports missing conditions as `NEEDS_SETUP` with a nonzero exit status.
These checks do not prove account access, provider tool support, search price,
OAuth consent status, push delivery, or a secure deployed reverse proxy. Those
require their respective integration and live verification tasks.

Current local preflight: Bun 1.4.4 and Canvas CLI 1.15.8 on Windows
(`C:/Programs/canvas-cli_windows_x86_64/canvas`, SHA-256
`5e12c925a48037e393e14efbc0bf9472af5bc56b09b6c9711d47eac40967d947`).
Docker is unavailable locally; this Windows binary cannot establish a Linux
installation or authentication path. The locked direct dependencies have
installed license files: Zod MIT, TypeScript Apache-2.0, and Bun types MIT.
No provider text/tool capability, current provider pricing, or Firecrawl
search/scrape account pricing has been verified with a live call; live doctor
therefore reports these as `NEEDS_SETUP` until Tasks 7 and 19 provide proof.

The command names `dev`, `start`, `worker`, and `qa` reserve the entrypoints
implemented in subsequent plan tasks. Until those tasks land, the commands
fail because their entrypoints do not exist; they must never report success
without performing their promised behavior.

Do not put credentials into a config fixture. Pass them as server-side
environment variables at deployment. `ASSISTANT_DATA_ROOT` can select the
data volume; the default local probe uses an OS temporary directory.

## Sandbox runner for approved scripts

Generated scripts never execute on the web or worker host. They run through
a separate runner that owns the Docker socket:

- `deploy/sandbox-runner.Dockerfile` builds the runner (Bun + Docker CLI).
  It needs `RUNNER_TOKEN` (16+ chars), `SANDBOX_ROOT` (its own view of the
  sandbox volume) and `SANDBOX_HOST_ROOT` (the same volume as the daemon sees
  it, only when the two paths differ).
- `deploy/script-runner.Dockerfile` builds the sandbox image that supplies the
  Bun runtime. The approved script is mounted read-only at `/in`, and only the
  per-run `/out` directory is writable.
- The worker calls the runner with `ASSISTANT_SANDBOX_URL` and
  `ASSISTANT_SANDBOX_TOKEN`. Without them a script run fails closed with
  `sandbox_unavailable`; there is no unisolated fallback, including in local
  development.

A generated script also needs an active, user-approved `tool_versions` row
whose `artifact_digest` matches the manifest; a collector script (`kind:
"collector"`) uses the same runner without that gate because it ships with
the application.
