FROM oven/bun:1.4.4-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
# The build context has no .git, so the commit the web bundle reports comes from CD.
ARG GIT_COMMIT=
RUN bun run build:web

FROM oven/bun:1.4.4-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/jobs ./jobs
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/tsconfig.json ./
EXPOSE 4318
ENV PORT=4318 HARNESS_DB=/data/harness.db HARNESS_WORKSPACE=/data/workspace
CMD ["bun", "src/server/main.ts"]
