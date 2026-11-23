# Sandbox image for one approved script. The script is baked into /in/main.ts at
# build time from the artifact whose sha256 was approved by the user; the runner
# mounts this image read-only, with no network, no capabilities and a non-root id.
FROM oven/bun:1.4.4-alpine

ENV HOME=/tmp \
    BUN_INSTALL_CACHE_DIR=/tmp/bun-cache

RUN mkdir -p /in /out && chmod 0555 /in && chmod 0777 /out

USER 65534:65534
WORKDIR /in
# No ENTRYPOINT: the runner passes the full command explicitly so argv reaches
# the script without duplication.
