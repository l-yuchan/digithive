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
