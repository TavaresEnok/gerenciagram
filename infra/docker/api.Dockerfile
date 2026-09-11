# syntax=docker/dockerfile:1.7
# ============================================================================
#  API (Fastify) — build multi-stage
#  Contexto de build = raiz do monorepo
# ============================================================================

FROM node:22-alpine AS base
# openssl: exigido pelo engine do Prisma no Alpine (musl)
# tini: PID 1 correto, garante shutdown gracioso (drena requisições em voo)
RUN apk add --no-cache openssl tini
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
WORKDIR /app

# ---------------------------------------------------------------------------
# Dependências: camada separada para aproveitar cache entre builds.
#
# Copiar os package.json de TODOS os pacotes da árvore de dependências é
# obrigatório: sem o de @app/platform, o pnpm não cria o link do workspace e
# o tsc falha com "Cannot find module '@app/platform'".
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/platform/package.json packages/platform/
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile \
      --filter @app/api... \
      --filter @app/core \
      --filter @app/db \
      --filter @app/platform

# ---------------------------------------------------------------------------
# Alvo de desenvolvimento: hot reload via tsx, código vem por bind mount
FROM base AS dev
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/packages/platform/node_modules ./packages/platform/node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY . .
RUN pnpm --filter @app/db exec prisma generate
EXPOSE 3001
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["pnpm", "--filter", "@app/api", "run", "dev"]

# ---------------------------------------------------------------------------
# A ordem do build importa: cada pacote precisa estar compilado antes do que
# o importa, porque o tsc resolve os tipos pelos `dist/` gerados.
FROM deps AS build
COPY . .
RUN pnpm --filter @app/db exec prisma generate \
 && pnpm --filter @app/core run build \
 && pnpm --filter @app/db run build \
 && pnpm --filter @app/platform run build \
 && pnpm --filter @app/api run build \
 && pnpm deploy --legacy --filter @app/api --prod /prod/api

# ---------------------------------------------------------------------------
FROM base AS production
ENV NODE_ENV=production
# Nunca rodar como root (SPEC seção 10 — menor privilégio)
RUN addgroup -g 1001 -S app && adduser -u 1001 -S app -G app
COPY --from=build --chown=app:app /prod/api /app
COPY --from=build --chown=app:app /app/packages/db/prisma /app/prisma
USER app
EXPOSE 3001
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
