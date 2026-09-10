import { PLATFORM_KEYS, getPlatformDefinition, type PlatformKey } from '@app/core';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { requireAuth } from '../../plugins/auth.js';
import type { AppInstance } from '../../types.js';

/**
 * Analytics (SPEC seção 6, Fase 11).
 *
 * Princípio que atravessa o módulo: métrica que a API oficial não fornece
 * fica AUSENTE, e o endpoint diz quais são. Preencher com zero, estimar ou
 * interpolar seria inventar dado — e num gráfico de crescimento, um zero é
 * indistinguível de uma queda real.
 */

const SERIES_METRICS = [
  'followers',
  'views',
  'likes',
  'comments',
  'shares',
  'saves',
  'impressions',
  'reach',
  'clicks',
] as const;

export async function registerAnalyticsRoutes(
  app: AppInstance,
  container: Container,
): Promise<void> {
  const { prisma } = container;

  app.get(
    '/analytics/overview',
    {
      preHandler: app.requirePermission('analytics:read'),
      schema: {
        tags: ['Analytics'],
        summary: 'Comparativo entre redes no período',
        querystring: z.object({
          from: z.coerce.date(),
          to: z.coerce.date(),
          clientId: z.string().uuid().optional(),
          groupId: z.string().uuid().optional(),
        }),
        response: {
          200: z.object({
            period: z.object({ from: z.string(), to: z.string() }),
            byPlatform: z.array(
              z.object({
                platform: z.enum(PLATFORM_KEYS),
                platformName: z.string(),
                accounts: z.number(),
                followers: z.number().nullable(),
                followersGrowth: z.number().nullable(),
                publishedPosts: z.number(),
                totals: z.record(z.number()),
                unavailableMetrics: z.array(z.string()),
              }),
            ),
          }),
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const { from, to } = request.query;

      const accounts = await prisma.socialAccount.findMany({
        where: {
          organizationId: auth.organizationId,
          deletedAt: null,
          ...(request.query.clientId ? { clientId: request.query.clientId } : {}),
          ...(request.query.groupId
            ? { groupMemberships: { some: { accountGroupId: request.query.groupId } } }
            : {}),
          ...(auth.scopedClientIds.length > 0
            ? { clientId: { in: auth.scopedClientIds } }
            : {}),
        },
        select: { id: true, platform: true },
      });

      if (accounts.length === 0) {
        return { period: { from: from.toISOString(), to: to.toISOString() }, byPlatform: [] };
      }

      const accountIds = accounts.map((account) => account.id);

      const [snapshots, publishedCounts] = await Promise.all([
        prisma.analyticsSnapshot.findMany({
          where: {
            organizationId: auth.organizationId,
            socialAccountId: { in: accountIds },
            capturedFor: { gte: from, lte: to },
          },
          orderBy: { capturedFor: 'asc' },
        }),
        prisma.postTarget.groupBy({
          by: ['platform'],
          where: {
            organizationId: auth.organizationId,
            socialAccountId: { in: accountIds },
            status: 'PUBLISHED',
            publishedAt: { gte: from, lte: to },
            deletedAt: null,
          },
          _count: { _all: true },
        }),
      ]);

      const platforms = [...new Set(accounts.map((account) => account.platform))];

      const byPlatform = platforms.map((platform) => {
        const platformAccounts = accounts.filter((account) => account.platform === platform);
        const ids = new Set(platformAccounts.map((account) => account.id));

        const platformSnapshots = snapshots.filter((snapshot) =>
          ids.has(snapshot.socialAccountId),
        );

        // Métricas de POST somam no período. Métricas de CONTA (seguidores)
        // não: o valor corrente é o do snapshot mais recente de cada conta.
        const postSnapshots = platformSnapshots.filter((s) => s.postTargetId !== null);
        const accountSnapshots = platformSnapshots.filter((s) => s.postTargetId === null);

        const totals: Record<string, number> = {};
        const seen = new Set<string>();

        for (const snapshot of postSnapshots) {
          for (const metric of SERIES_METRICS) {
            if (metric === 'followers') continue;
            const value = snapshot[metric];
            if (typeof value !== 'number') continue;
            seen.add(metric);
            totals[metric] = (totals[metric] ?? 0) + value;
          }
        }

        const latestByAccount = new Map<string, number>();
        const earliestByAccount = new Map<string, number>();

        for (const snapshot of accountSnapshots) {
          if (typeof snapshot.followers !== 'number') continue;
          seen.add('followers');
          latestByAccount.set(snapshot.socialAccountId, snapshot.followers);
          if (!earliestByAccount.has(snapshot.socialAccountId)) {
            earliestByAccount.set(snapshot.socialAccountId, snapshot.followers);
          }
        }

        const followers = latestByAccount.size > 0
          ? [...latestByAccount.values()].reduce((sum, value) => sum + value, 0)
          : null;

        const followersStart = earliestByAccount.size > 0
          ? [...earliestByAccount.values()].reduce((sum, value) => sum + value, 0)
          : null;

        return {
          platform,
          platformName: getPlatformDefinition(platform).displayName,
          accounts: platformAccounts.length,
          followers,
          followersGrowth:
            followers !== null && followersStart !== null ? followers - followersStart : null,
          publishedPosts:
            publishedCounts.find((row) => row.platform === platform)?._count._all ?? 0,
          totals,
          unavailableMetrics: SERIES_METRICS.filter((metric) => !seen.has(metric)),
        };
      });

      return { period: { from: from.toISOString(), to: to.toISOString() }, byPlatform };
    },
  );

  app.get(
    '/analytics/series',
    {
      preHandler: app.requirePermission('analytics:read'),
      schema: {
        tags: ['Analytics'],
        summary: 'Série temporal de uma métrica',
        description:
          'Os pontos vêm dos snapshots diários. Dias sem coleta ficam AUSENTES da ' +
          'série — não são preenchidos com zero nem interpolados.',
        querystring: z.object({
          metric: z.enum(SERIES_METRICS),
          from: z.coerce.date(),
          to: z.coerce.date(),
          accountId: z.string().uuid().optional(),
          groupId: z.string().uuid().optional(),
          platform: z.enum(PLATFORM_KEYS).optional(),
        }),
        response: {
          200: z.object({
            metric: z.string(),
            points: z.array(z.object({ date: z.string(), value: z.number() })),
            /** Dias do período sem nenhuma coleta. */
            missingDays: z.number(),
          }),
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const { metric, from, to } = request.query;

      const snapshots = await prisma.analyticsSnapshot.findMany({
        where: {
          organizationId: auth.organizationId,
          capturedFor: { gte: from, lte: to },
          ...(request.query.accountId ? { socialAccountId: request.query.accountId } : {}),
          ...(request.query.platform ? { platform: request.query.platform } : {}),
          ...(request.query.groupId
            ? {
                socialAccount: {
                  groupMemberships: { some: { accountGroupId: request.query.groupId } },
                },
              }
            : {}),
          ...(auth.scopedClientIds.length > 0
            ? { socialAccount: { clientId: { in: auth.scopedClientIds } } }
            : {}),
          // Métrica de conta vem do snapshot de conta; as demais, dos posts.
          ...(metric === 'followers' ? { postTargetId: null } : { postTargetId: { not: null } }),
        },
        select: { capturedFor: true, [metric]: true } as never,
        orderBy: { capturedFor: 'asc' },
      });

      const byDay = new Map<string, number>();

      for (const snapshot of snapshots as Array<Record<string, unknown>>) {
        const value = snapshot[metric];
        if (typeof value !== 'number') continue;

        const day = (snapshot['capturedFor'] as Date).toISOString().slice(0, 10);
        byDay.set(day, (byDay.get(day) ?? 0) + value);
      }

      const totalDays = Math.max(
        1,
        Math.ceil((to.getTime() - from.getTime()) / (24 * 60 * 60_000)) + 1,
      );

      return {
        metric,
        points: [...byDay.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, value]) => ({ date, value })),
        missingDays: Math.max(0, totalDays - byDay.size),
      };
    },
  );

  app.get(
    '/analytics/accounts',
    {
      preHandler: app.requirePermission('analytics:read'),
      schema: {
        tags: ['Analytics'],
        summary: 'Desempenho por conta conectada',
        querystring: z.object({
          from: z.coerce.date(),
          to: z.coerce.date(),
          groupId: z.string().uuid().optional(),
        }),
        response: {
          200: z.object({
            accounts: z.array(
              z.object({
                accountId: z.string(),
                nickname: z.string(),
                platform: z.enum(PLATFORM_KEYS),
                followers: z.number().nullable(),
                publishedPosts: z.number(),
                failedPosts: z.number(),
                totals: z.record(z.number()),
              }),
            ),
          }),
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const { from, to } = request.query;

      const accounts = await prisma.socialAccount.findMany({
        where: {
          organizationId: auth.organizationId,
          deletedAt: null,
          ...(request.query.groupId
            ? { groupMemberships: { some: { accountGroupId: request.query.groupId } } }
            : {}),
          ...(auth.scopedClientIds.length > 0
            ? { clientId: { in: auth.scopedClientIds } }
            : {}),
        },
        select: {
          id: true,
          nickname: true,
          platform: true,
          analytics: {
            where: { capturedFor: { gte: from, lte: to } },
            orderBy: { capturedFor: 'desc' },
          },
          postTargets: {
            where: { publishedAt: { gte: from, lte: to }, deletedAt: null },
            select: { status: true },
          },
        },
        orderBy: [{ platform: 'asc' }, { nickname: 'asc' }],
      });

      return {
        accounts: accounts.map((account) => {
          const accountSnapshot = account.analytics.find((s) => s.postTargetId === null);
          const postSnapshots = account.analytics.filter((s) => s.postTargetId !== null);

          const totals: Record<string, number> = {};
          const latestPerTarget = new Map<string, (typeof postSnapshots)[number]>();

          // Um snapshot por destino (o mais recente): a lista já vem ordenada
          // do mais novo para o mais antigo.
          for (const snapshot of postSnapshots) {
            if (!snapshot.postTargetId) continue;
            if (!latestPerTarget.has(snapshot.postTargetId)) {
              latestPerTarget.set(snapshot.postTargetId, snapshot);
            }
          }

          for (const snapshot of latestPerTarget.values()) {
            for (const metric of SERIES_METRICS) {
              if (metric === 'followers') continue;
              const value = snapshot[metric];
              if (typeof value === 'number') {
                totals[metric] = (totals[metric] ?? 0) + value;
              }
            }
          }

          return {
            accountId: account.id,
            nickname: account.nickname,
            platform: account.platform as PlatformKey,
            followers: accountSnapshot?.followers ?? null,
            publishedPosts: account.postTargets.filter((t) => t.status === 'PUBLISHED').length,
            failedPosts: account.postTargets.filter((t) => t.status === 'FAILED').length,
            totals,
          };
        }),
      };
    },
  );
}
