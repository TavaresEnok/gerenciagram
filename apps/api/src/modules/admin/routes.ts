import { ForbiddenError, NotFoundError, PLATFORM_KEYS, QUEUE_NAMES } from '@app/core';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { recordAudit } from '../../lib/audit.js';
import { requireAuth } from '../../plugins/auth.js';
import type { AppInstance } from '../../types.js';

/**
 * Painel interno do dono do SaaS (SPEC seção 6).
 *
 * Fora do RBAC de tenant: o acesso vem de `User.isPlatformAdmin`, não de
 * papel de organização. Um Owner de uma organização qualquer não pode chegar
 * aqui — nem por engano, nem por escalação de papel.
 *
 * As rotas atravessam tenants de propósito (é o ponto do painel), então cada
 * uma agrega em vez de listar dado bruto de cliente.
 */

async function assertPlatformAdmin(
  container: Container,
  userId: string,
): Promise<void> {
  const user = await container.prisma.user.findUnique({
    where: { id: userId },
    select: { isPlatformAdmin: true, deletedAt: true },
  });

  if (!user || user.deletedAt || !user.isPlatformAdmin) {
    // Mesma resposta de "não existe": um 403 específico confirmaria a
    // existência do painel para quem está sondando.
    throw new ForbiddenError('Você não tem acesso a este recurso.');
  }
}

export async function registerAdminRoutes(
  app: AppInstance,
  container: Container,
): Promise<void> {
  const { prisma } = container;

  app.get(
    '/admin/overview',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Admin da plataforma'],
        summary: 'Visão geral: organizações, uso, erros e filas',
        response: {
          200: z.object({
            organizations: z.object({
              total: z.number(),
              active30d: z.number(),
              byPlan: z.record(z.number()),
            }),
            usage: z.object({
              users: z.number(),
              socialAccounts: z.number(),
              accountsByPlatform: z.record(z.number()),
              storageBytes: z.number(),
              publishedLast7d: z.number(),
            }),
            errors: z.object({
              failedTargets7d: z.number(),
              deadLetterOpen: z.number(),
              accountsNeedingReconnect: z.number(),
              failureRateByPlatform: z.record(z.number()),
            }),
            queues: z.array(
              z.object({
                name: z.string(),
                waiting: z.number(),
                active: z.number(),
                delayed: z.number(),
                failed: z.number(),
              }),
            ),
            circuits: z.array(
              z.object({
                platform: z.enum(PLATFORM_KEYS),
                state: z.string(),
                failureCount: z.number(),
                openedAt: z.string().nullable(),
              }),
            ),
          }),
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await assertPlatformAdmin(container, auth.userId);

      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60_000);
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60_000);

      const [
        totalOrgs,
        activeOrgs,
        subscriptions,
        users,
        accounts,
        storage,
        published7d,
        failed7d,
        deadLetterOpen,
        needingReconnect,
        failureByPlatform,
        publishedByPlatform,
        circuits,
      ] = await Promise.all([
        prisma.organization.count({ where: { deletedAt: null } }),
        prisma.organization.count({
          where: { deletedAt: null, posts: { some: { createdAt: { gte: thirtyDaysAgo } } } },
        }),
        prisma.subscription.findMany({ include: { plan: { select: { tier: true } } } }),
        prisma.membership.count({ where: { deletedAt: null, status: 'ACTIVE' } }),
        prisma.socialAccount.groupBy({
          by: ['platform'],
          where: { deletedAt: null },
          _count: { _all: true },
        }),
        prisma.mediaAsset.aggregate({ where: { deletedAt: null }, _sum: { sizeBytes: true } }),
        prisma.postTarget.count({
          where: { status: 'PUBLISHED', publishedAt: { gte: sevenDaysAgo } },
        }),
        prisma.postTarget.count({
          where: { status: 'FAILED', updatedAt: { gte: sevenDaysAgo } },
        }),
        prisma.deadLetterJob.count({ where: { resolvedAt: null } }),
        prisma.socialAccount.count({ where: { status: 'NEEDS_RECONNECT', deletedAt: null } }),
        prisma.postTarget.groupBy({
          by: ['platform'],
          where: { status: 'FAILED', updatedAt: { gte: sevenDaysAgo } },
          _count: { _all: true },
        }),
        prisma.postTarget.groupBy({
          by: ['platform'],
          where: { status: 'PUBLISHED', publishedAt: { gte: sevenDaysAgo } },
          _count: { _all: true },
        }),
        prisma.socialPlatform.findMany({
          select: {
            key: true,
            circuitState: true,
            circuitFailureCount: true,
            circuitOpenedAt: true,
          },
        }),
      ]);

      const byPlan: Record<string, number> = {};
      for (const subscription of subscriptions) {
        byPlan[subscription.plan.tier] = (byPlan[subscription.plan.tier] ?? 0) + 1;
      }

      const accountsByPlatform: Record<string, number> = {};
      for (const row of accounts) accountsByPlatform[row.platform] = row._count._all;

      // Taxa de falha = falhas / (falhas + sucessos) por plataforma. É a
      // métrica que a SPEC seção 13 pede para alertar.
      const failureRateByPlatform: Record<string, number> = {};
      for (const row of failureByPlatform) {
        const successes =
          publishedByPlatform.find((p) => p.platform === row.platform)?._count._all ?? 0;
        const total = row._count._all + successes;
        failureRateByPlatform[row.platform] =
          total > 0 ? Math.round((row._count._all / total) * 1000) / 10 : 0;
      }

      const queues = await Promise.all(
        Object.entries(container.queues).map(async ([name, queue]) => {
          const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
          return {
            name,
            waiting: counts['waiting'] ?? 0,
            active: counts['active'] ?? 0,
            delayed: counts['delayed'] ?? 0,
            failed: counts['failed'] ?? 0,
          };
        }),
      );

      return {
        organizations: { total: totalOrgs, active30d: activeOrgs, byPlan },
        usage: {
          users,
          socialAccounts: accounts.reduce((sum, row) => sum + row._count._all, 0),
          accountsByPlatform,
          storageBytes: Number(storage._sum.sizeBytes ?? 0n),
          publishedLast7d: published7d,
        },
        errors: {
          failedTargets7d: failed7d,
          deadLetterOpen,
          accountsNeedingReconnect: needingReconnect,
          failureRateByPlatform,
        },
        queues,
        circuits: circuits.map((circuit) => ({
          platform: circuit.key,
          state: circuit.circuitState,
          failureCount: circuit.circuitFailureCount,
          openedAt: circuit.circuitOpenedAt?.toISOString() ?? null,
        })),
      };
    },
  );

  app.get(
    '/admin/dead-letter',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Admin da plataforma'],
        summary: 'Jobs que esgotaram as tentativas',
        description:
          'A dead-letter queue da SPEC seção 12: nada some silenciosamente. Cada linha ' +
          'guarda o payload e o motivo, para reprocessar ou diagnosticar.',
        querystring: z.object({
          queueName: z.string().optional(),
          resolved: z.coerce.boolean().default(false),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
        response: {
          200: z.object({
            jobs: z.array(
              z.object({
                id: z.string(),
                queueName: z.string(),
                jobName: z.string(),
                jobId: z.string().nullable(),
                organizationId: z.string().nullable(),
                attemptsMade: z.number(),
                failedReason: z.string().nullable(),
                correlationId: z.string().nullable(),
                createdAt: z.string(),
                resolvedAt: z.string().nullable(),
              }),
            ),
            total: z.number(),
          }),
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await assertPlatformAdmin(container, auth.userId);

      const where = {
        ...(request.query.queueName ? { queueName: request.query.queueName } : {}),
        ...(request.query.resolved ? { resolvedAt: { not: null } } : { resolvedAt: null }),
      };

      const [jobs, total] = await Promise.all([
        prisma.deadLetterJob.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: request.query.limit,
        }),
        prisma.deadLetterJob.count({ where }),
      ]);

      return {
        jobs: jobs.map((job) => ({
          id: job.id,
          queueName: job.queueName,
          jobName: job.jobName,
          jobId: job.jobId,
          organizationId: job.organizationId,
          attemptsMade: job.attemptsMade,
          failedReason: job.failedReason,
          correlationId: job.correlationId,
          createdAt: job.createdAt.toISOString(),
          resolvedAt: job.resolvedAt?.toISOString() ?? null,
        })),
        total,
      };
    },
  );

  app.post(
    '/admin/dead-letter/:jobId/resolve',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Admin da plataforma'],
        summary: 'Marca um job da dead-letter como tratado',
        params: z.object({ jobId: z.string().uuid() }),
        body: z.object({ resolution: z.string().max(1000) }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      await assertPlatformAdmin(container, auth.userId);

      const updated = await prisma.deadLetterJob.updateMany({
        where: { id: request.params.jobId, resolvedAt: null },
        data: {
          resolvedAt: new Date(),
          resolvedBy: auth.userId,
          resolution: request.body.resolution,
        },
      });
      if (updated.count === 0) throw new NotFoundError('Job', request.params.jobId);

      return reply.status(204).send(null);
    },
  );

  app.post(
    '/admin/circuits/:platform/reset',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Admin da plataforma'],
        summary: 'Fecha manualmente o circuito de uma plataforma',
        description:
          'Use quando souber que a plataforma voltou antes de a janela do breaker ' +
          'expirar. Fechar com a plataforma ainda fora do ar só faz o circuito reabrir.',
        params: z.object({ platform: z.enum(PLATFORM_KEYS) }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      await assertPlatformAdmin(container, auth.userId);

      await prisma.socialPlatform.update({
        where: { key: request.params.platform },
        data: {
          circuitState: 'CLOSED',
          circuitFailureCount: 0,
          circuitOpenedAt: null,
          circuitHalfOpenAt: null,
        },
      });

      await recordAudit(prisma, {
        actorUserId: auth.userId,
        action: 'admin.circuit_reset',
        entityType: 'SocialPlatform',
        entityId: request.params.platform,
        correlationId: request.correlationId,
      });

      return reply.status(204).send(null);
    },
  );

  app.get(
    '/admin/organizations',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Admin da plataforma'],
        summary: 'Lista as organizações com uso agregado',
        querystring: z.object({
          search: z.string().max(120).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: {
          200: z.object({
            organizations: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                slug: z.string(),
                plan: z.string().nullable(),
                planStatus: z.string().nullable(),
                members: z.number(),
                accounts: z.number(),
                postsLast30d: z.number(),
                createdAt: z.string(),
              }),
            ),
            total: z.number(),
          }),
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await assertPlatformAdmin(container, auth.userId);

      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60_000);

      const where = {
        deletedAt: null,
        ...(request.query.search
          ? { name: { contains: request.query.search, mode: 'insensitive' as const } }
          : {}),
      };

      const [organizations, total] = await Promise.all([
        prisma.organization.findMany({
          where,
          include: {
            subscription: { include: { plan: { select: { name: true } } } },
            _count: {
              select: {
                memberships: { where: { deletedAt: null } },
                socialAccounts: { where: { deletedAt: null } },
                posts: { where: { createdAt: { gte: thirtyDaysAgo }, deletedAt: null } },
              },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: request.query.limit,
          skip: request.query.offset,
        }),
        prisma.organization.count({ where }),
      ]);

      return {
        organizations: organizations.map((organization) => ({
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          plan: organization.subscription?.plan.name ?? null,
          planStatus: organization.subscription?.status ?? null,
          members: organization._count.memberships,
          accounts: organization._count.socialAccounts,
          postsLast30d: organization._count.posts,
          createdAt: organization.createdAt.toISOString(),
        })),
        total,
      };
    },
  );

  app.get(
    '/admin/queues/:queueName/failed',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Admin da plataforma'],
        summary: 'Jobs falhos ainda na fila do BullMQ',
        params: z.object({ queueName: z.enum(Object.values(QUEUE_NAMES) as [string, ...string[]]) }),
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }),
        response: {
          200: z.object({
            jobs: z.array(
              z.object({
                id: z.string().nullable(),
                name: z.string(),
                attemptsMade: z.number(),
                failedReason: z.string().nullable(),
                timestamp: z.number(),
              }),
            ),
          }),
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await assertPlatformAdmin(container, auth.userId);

      const queue = Object.values(container.queues).find(
        (candidate) => candidate.name === request.params.queueName,
      );
      if (!queue) throw new NotFoundError('Fila', request.params.queueName);

      const jobs: Array<{
        id?: string | undefined;
        name: string;
        attemptsMade: number;
        failedReason?: string | undefined;
        timestamp: number;
      }> = await queue.getFailed(0, request.query.limit - 1);

      return {
        jobs: jobs.map((job) => ({
          id: job.id ?? null,
          name: job.name,
          attemptsMade: job.attemptsMade,
          failedReason: job.failedReason ?? null,
          timestamp: job.timestamp,
        })),
      };
    },
  );
}
