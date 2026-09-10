# syntax=docker/dockerfile:1.7
# ============================================================================
#  Worker (BullMQ + FFmpeg)
#
#  Processo separado da API de propósito: processamento de vídeo é CPU-bound
#  e não pode competir com o event loop que atende o p95 de 300ms da API
#  (SPEC seção 2). Escala horizontalmente de forma independente.
# ============================================================================

FROM node:22-alpine AS base
RUN apk add --no-cache openssl tini ffmpeg
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY apps/worker/package.json apps/worker/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @app/worker... --filter @app/core --filter @app/db

FROM base AS dev
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/apps/worker/node_modules ./apps/worker/node_modules
COPY . .
RUN pnpm --filter @app/db exec prisma generate
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["pnpm", "--filter", "@app/worker", "run", "dev"]

FROM deps AS build
COPY . .
RUN pnpm --filter @app/db exec prisma generate \
 && pnpm --filter @app/core run build \
 && pnpm --filter @app/db run build \
 && pnpm --filter @app/worker run build \
 && pnpm deploy --filter @app/worker --prod /prod/worker

FROM base AS production
ENV NODE_ENV=production
RUN addgroup -g 1001 -S app && adduser -u 1001 -S app -G app
COPY --from=build --chown=app:app /prod/worker /app
COPY --from=build --chown=app:app /app/packages/db/prisma /app/prisma
USER app
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
