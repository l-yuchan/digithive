# CI and CD

The workflow files live in `.github/workflows/` and only act on `apps/harness`.
Nothing else in the repository is built or deployed.

## ci.yml

Triggers: every push to `main`, every pull request, manual dispatch.

Two jobs on `ubuntu-latest`:

- `verify` runs in `apps/harness` with bun 1.4.4 pinned by
  `oven-sh/setup-bun`: `bun install --frozen-lockfile`, then `lint`,
  `typecheck`, `build:web`, `test`, `fmt:check` as separate steps so a failure
  names the stage.
- `image` builds the Dockerfile without pushing, so Dockerfile drift fails in
  CI rather than on the server.

## cd.yml

Triggers: push to `main`, manual dispatch. `concurrency: cd-main` keeps one
deployment at a time.

1. `publish` builds `apps/harness` and pushes
   `ghcr.io/l-yuchan/digithive-harness:<sha>` and `:latest`. It needs
   `packages: write`; the workflow-level permission is `contents: read`.
2. `deploy` runs on the self-hosted runner labelled `mini` (the homelab box;
   GitHub-hosted runners cannot reach it, it has no inbound SSH from the
   internet). It logs in to GHCR for the job only via a temporary
   `DOCKER_CONFIG`, syncs `apps/harness/deploy/compose.yml` into
   `/home/leefam/digithive-harness/deploy/`, pulls the commit's image tag,
   restarts both services with `--no-build`, writes the deployed tag to
   `.harness_image`, and requires `https://digithive.chanoil.com/api/session`
   to answer within 60 seconds.
3. If the health check fails, the last step restores the previous image
   recorded in `.harness_image` (falling back to the inspected running
   container) and the run fails, so the breakage is visible in Actions.

Secrets stay on the server: `/home/leefam/digithive-harness/deploy/.env` is
never copied into the repository or into GitHub secrets. The only credential
GitHub holds is its own `GITHUB_TOKEN`.

### Manual rollback

```bash
cd /home/leefam/digithive-harness/deploy
HARNESS_IMAGE=ghcr.io/l-yuchan/digithive-harness:<sha> docker compose up -d --no-build
```

Any published commit tag works; `latest` follows `main`.

## Self-hosted runner

- Name `mini-digithive`, labels `self-hosted`, `Linux`, `X64`, `mini`, working
  directory `/home/leefam/actions-runner/_work`.
- Installed from `actions/runner` v2.338.2 into `/home/leefam/actions-runner`.
- The box has no `libicu` and no passwordless sudo, so the runner runs with
  `LD_LIBRARY_PATH=/home/leefam/libicu/usr/lib/x86_64-linux-gnu`, pointing at
  an unprivileged `dpkg-deb -x` extraction of `libicu76`.
- Start command: `LD_LIBRARY_PATH=... ./run.sh` inside `~/actions-runner`.

### Known gap: no boot autostart yet

Both usual unattended-start paths are blocked on that box right now, and both
need the owner:

- `loginctl enable-linger leefam` answers "Access denied" (polkit), so a
  `systemd --user` unit would stop when the last session ends.
- `crontab -` fails with "No space left on device" because `/var` (6.2 GB) is
  at 100% with only root-reserved space left, so no `@reboot` entry can be
  written. Freeing `/var` or installing the runner as a system service needs
  sudo.

Until one of those is done, the runner is started by hand after a reboot:

```bash
ssh mini 'cd ~/actions-runner && setsid nohup env \
  LD_LIBRARY_PATH=$HOME/libicu/usr/lib/x86_64-linux-gnu ./run.sh \
  >> runner.log 2>&1 < /dev/null &'
```
