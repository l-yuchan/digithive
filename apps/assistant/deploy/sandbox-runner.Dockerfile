# Sandbox runner: the only process that may talk to the Docker socket. It accepts
# a narrow, validated run request and translates it into a hardened `docker run`.
# Build from apps/assistant:  docker build -f deploy/sandbox-runner.Dockerfile .
FROM oven/bun:1.4.4-alpine

RUN apk add --no-cache docker-cli

WORKDIR /app
COPY package.json bun.lock ./
# Only zod is needed at runtime; the lockfile pins the exact resolution.
RUN bun install --frozen-lockfile --production
COPY src/contracts/tools.ts src/contracts/tools.ts
COPY deploy/sandbox-runner/server.ts deploy/sandbox-runner/server.ts

ENV RUNNER_PORT=4400 \
    SANDBOX_ROOT=/work \
    SANDBOX_IMAGE_PREFIX=dg-script:

EXPOSE 4400
CMD ["bun", "deploy/sandbox-runner/server.ts"]
