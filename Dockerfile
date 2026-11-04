# syntax=docker/dockerfile:1.7
#
# InvestNow WhatsApp API: NestJS on Bun, three stages.
#
#   docker build -t ucap-whatsapp-api .
#   docker run -p 3000:3000 -v investnow-data:/data --env-file .env ucap-whatsapp-api
#
# State lives in /data (SQLite: app data, sessions, job queue, security
# counters, admin sessions): mount a volume there.

ARG BUN_VERSION=1.4.4

# ---------------------------------------------------------------- build
# Every dependency, to bundle the chat and admin UIs (React is a dev dependency).
FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY ui ./ui
RUN bun run ui:build

# ---------------------------------------------------------------- production dependencies
FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

# ---------------------------------------------------------------- runtime
FROM oven/bun:${BUN_VERSION}-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    ENABLE_DEV_ROUTES=false

COPY --from=deps /app/node_modules ./node_modules
# Bun reads emitDecoratorMetadata from the working directory's tsconfig.json,
# which Nest's dependency injection needs at run time.
COPY package.json tsconfig.json ./
COPY src ./src
# The built admin UI (served at /admin). The chat simulator is a dev tool and
# is not served in production.
COPY --from=build /app/dist/admin ./dist/admin

RUN mkdir -p /data && chown -R bun:bun /data
USER bun
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["bun", "src/main.ts"]
