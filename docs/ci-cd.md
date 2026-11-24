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

The runner is a container on `mini`, not a host process:

| piece | value |
| --- | --- |
| container | `digithive-runner`, `--restart unless-stopped` |
| image | `ghcr.io/actions/actions-runner:latest` |
| name / labels | `mini-digithive` / `self-hosted`, `Linux`, `X64`, `mini` |
| state | `/home/leefam/runner-container` on the host, mounted at `/home/runner` |
| mounts | docker socket, host `/usr/bin/docker`, host compose plugin, `/home/leefam/digithive-harness` |
| work dir | `/home/runner/_work` |

Because the container carries `--restart unless-stopped`, dockerd brings the
runner back after a reboot; no systemd unit, linger or cron entry is involved.
That matters on this box: `loginctl enable-linger` is refused by polkit and
`crontab -` fails because `/var` (6.2 GB) sits at 100% with only root-reserved
space left. Both of those host issues remain open for the owner.

The container runs as root inside its namespace (`RUNNER_ALLOW_RUNASROOT=1`),
which is required by the runner scripts and is equivalent to the `docker` group
membership the host user already has.

To reconfigure or re-register:

```bash
TOKEN=$(gh api -X POST repos/l-yuchan/digithive/actions/runners/registration-token --jq .token)
ssh mini "docker run --rm --user 0 -e RUNNER_ALLOW_RUNASROOT=1 \
  -v /home/leefam/runner-container:/home/runner -w /home/runner \
  ghcr.io/actions/actions-runner:latest ./config.sh --unattended \
  --url https://github.com/l-yuchan/digithive --token $TOKEN \
  --name mini-digithive --labels mini --work _work --replace"
ssh mini 'docker restart digithive-runner'
```

The previous host-installed runner at `/home/leefam/actions-runner` (with an
unprivileged `libicu76` extraction because the box has no libicu) is stopped and
superseded; the directory can be deleted.

