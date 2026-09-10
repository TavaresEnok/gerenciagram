import { NotFoundError } from '@app/core';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { recordAudit } from '../../lib/audit.js';
import { requireAuth } from '../../plugins/auth.js';
import type { AppInstance } from '../../types.js';

/**
 * Campanhas (SPEC seção 6).
 *
 * Agrupa publicações e consolida as métricas delas. A consolidação soma os
 * SNAPSHOTS MAIS RECENTES de cada destino — somar todos os snapshots
 * multiplicaria os números pelo número de coletas.
 */

const campaignSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  color: z.string().nullable(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  goal: z.string().nullable(),
  clientId: z.string().nullable(),
  clientName: z.string().nullable(),
  postCount: z.number(),
  createdAt: z.string(),
});

export async function registerCampaignRoutes(
  app: AppInstance,
  container: Container,
): Promise<void> {
  const { prisma } = container;

  app.get(
    '/campaigns',
    {
      preHandler: app.requirePermission('campaign:read'),
      schema: {
        tags: ['Campanhas'],
        summary: 'Lista as campanhas',
        querystring: z.object({ clientId: z.string().uuid().optional() }),
        response: { 200: z.object({ campaigns: z.array(campaignSchema) }) },
      },
    },
    async (request) => {
      const auth = requireAuth(request);

      const campaigns = await prisma.campaign.findMany({
        where: {
          organizationId: auth.organizationId,
          deletedAt: null,
          ...(request.query.clientId ? { clientId: request.query.clientId } : {}),
          ...(auth.scopedClientIds.length > 0
            ? { OR: [{ clientId: { in: auth.scopedClientIds } }, { clientId: null }] }
            : {}),
        },
        include: {
          client: { select: { name: true } },
          _count: { select: { posts: { where: { deletedAt: null } } } },
        },
        orderBy: { createdAt: 'desc' },
      });

      return {
        campaigns: campaigns.map((campaign) => ({
          id: campaign.id,
          name: campaign.name,
          description: campaign.description,
          color: campaign.color,
          startsAt: campaign.startsAt?.toISOString() ?? null,
          endsAt: campaign.endsAt?.toISOString() ?? null,
          goal: campaign.goal,
          clientId: campaign.clientId,
          clientName: campaign.client?.name ?? null,
          postCount: campaign._count.posts,
          createdAt: campaign.createdAt.toISOString(),
        })),
      };
    },
  );

  app.post(
    '/campaigns',
    {
      preHandler: app.requirePermission('campaign:create'),
      schema: {
        tags: ['Campanhas'],
        summary: 'Cria uma campanha',
        body: z.object({
          name: z.string().min(1).max(160),
          description: z.string().max(2000).optional(),
          color: z.string().max(20).optional(),
          clientId: z.string().uuid().optional(),
          startsAt: z.coerce.date().optional(),
          endsAt: z.coerce.date().optional(),
          goal: z.string().max(500).optional(),
        }),
        response: { 201: campaignSchema },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);

      const campaign = await prisma.campaign.create({
        data: {
          organizationId: auth.organizationId,
          name: request.body.name.trim(),
          description: request.body.description ?? null,
          color: request.body.color ?? null,
          clientId: request.body.clientId ?? null,
          startsAt: request.body.startsAt ?? null,
          endsAt: request.body.endsAt ?? null,
          goal: request.body.goal ?? null,
        },
        include: { client: { select: { name: true } } },
      });

      await recordAudit(prisma, {
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        action: 'campaign.create',
        entityType: 'Campaign',
        entityId: campaign.id,
        changes: { name: campaign.name },
        correlationId: request.correlationId,
      });

      return reply.status(201).send({
        id: campaign.id,
        name: campaign.name,
        description: campaign.description,
        color: campaign.color,
        startsAt: campaign.startsAt?.toISOString() ?? null,
        endsAt: campaign.endsAt?.toISOString() ?? null,
        goal: campaign.goal,
        clientId: campaign.clientId,
        clientName: campaign.client?.name ?? null,
        postCount: 0,
        createdAt: campaign.createdAt.toISOString(),
      });
    },
  );

  app.patch(
    '/campaigns/:campaignId',
    {
      preHandler: app.requirePermission('campaign:update'),
      schema: {
        tags: ['Campanhas'],
        summary: 'Atualiza uma campanha',
        params: z.object({ campaignId: z.string().uuid() }),
        body: z.object({
          name: z.string().min(1).max(160).optional(),
          description: z.string().max(2000).nullable().optional(),
          color: z.string().max(20).nullable().optional(),
          startsAt: z.coerce.date().nullable().optional(),
          endsAt: z.coerce.date().nullable().optional(),
          goal: z.string().max(500).nullable().optional(),
        }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);

      const updated = await prisma.campaign.updateMany({
        where: {
          id: request.params.campaignId,
          organizationId: auth.organizationId,
          deletedAt: null,
        },
        data: request.body,
      });
      if (updated.count === 0) throw new NotFoundError('Campanha', request.params.campaignId);

      return reply.status(204).send(null);
    },
  );

  app.delete(
    '/campaigns/:campaignId',
    {
      preHandler: app.requirePermission('campaign:delete'),
      schema: {
        tags: ['Campanhas'],
        summary: 'Remove uma campanha (soft-delete)',
        params: z.object({ campaignId: z.string().uuid() }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);

      const updated = await prisma.campaign.updateMany({
        where: {
          id: request.params.campaignId,
          organizationId: auth.organizationId,
          deletedAt: null,
        },
        data: { deletedAt: new Date() },
      });
      if (updated.count === 0) throw new NotFoundError('Campanha', request.params.campaignId);

      return reply.status(204).send(null);
    },
  );

  app.get(
    '/campaigns/:campaignId/metrics',
    {
      preHandler: app.requirePermission('analytics:read'),
      schema: {
        tags: ['Campanhas'],
        summary: 'Métricas consolidadas da campanha',
        params: z.object({ campaignId: z.string().uuid() }),
        response: {
          200: z.object({
            campaignId: z.string(),
            posts: z.object({
              total: z.number(),
              published: z.number(),
              failed: z.number(),
              pending: z.number(),
            }),
            totals: z.record(z.number()),
            byPlatform: z.record(z.record(z.number())),
            /** Métricas ausentes porque a API oficial da rede não as fornece. */
            unavailableMetrics: z.array(z.string()),
          }),
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);

      const campaign = await prisma.campaign.findFirst({
        where: {
          id: request.params.campaignId,
          organizationId: auth.organizationId,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!campaign) throw new NotFoundError('Campanha', request.params.campaignId);

      const targets = await prisma.postTarget.findMany({
        where: {
          organizationId: auth.organizationId,
          deletedAt: null,
          post: { campaignId: campaign.id, deletedAt: null },
        },
        select: {
          id: true,
          status: true,
          platform: true,
          analytics: {
            // Só o snapshot MAIS RECENTE de cada destino: somar todos
            // multiplicaria os números pela quantidade de coletas.
            orderBy: { capturedFor: 'desc' },
            take: 1,
          },
        },
      });

      const totals: Record<string, number> = {};
      const byPlatform: Record<string, Record<string, number>> = {};
      const METRICS = ['views', 'likes', 'comments', 'shares', 'saves', 'impressions', 'reach', 'clicks'] as const;
      const seen = new Set<string>();

      for (const target of targets) {
        const snapshot = target.analytics[0];
        if (!snapshot) continue;

        byPlatform[target.platform] ??= {};

        for (const metric of METRICS) {
          const value = snapshot[metric];
          if (typeof value !== 'number') continue;

          seen.add(metric);
          totals[metric] = (totals[metric] ?? 0) + value;
          byPlatform[target.platform]![metric] =
            (byPlatform[target.platform]![metric] ?? 0) + value;
        }
      }

      return {
        campaignId: campaign.id,
        posts: {
          total: targets.length,
          published: targets.filter((target) => target.status === 'PUBLISHED').length,
          failed: targets.filter((target) => target.status === 'FAILED').length,
          pending: targets.filter((target) =>
            ['PENDING', 'SCHEDULED', 'QUEUED', 'PUBLISHING'].includes(target.status),
          ).length,
        },
        totals,
        byPlatform,
        // Transparência: dizemos quais métricas NÃO vieram, em vez de exibir
        // zero — que num gráfico é indistinguível de uma queda real.
        unavailableMetrics: METRICS.filter((metric) => !seen.has(metric)),
      };
    },
  );
}
