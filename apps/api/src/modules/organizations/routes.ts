import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ROLES,
  ValidationError,
  assertValidTimezone,
  permissionsForRole,
} from '@app/core';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { recordAudit } from '../../lib/audit.js';
import { requireAuth } from '../../plugins/auth.js';
import type { AppInstance } from '../../types.js';
import { AuthService } from '../auth/service.js';

/**
 * Organização, membros e papéis (SPEC seção 5).
 *
 * Duas travas que existem para o RBAC não virar decoração:
 *
 *  1. Ninguém altera o próprio papel. Um Admin poderia se promover a Owner e
 *     o controle inteiro perderia sentido.
 *  2. A organização não pode ficar sem Owner ativo — nem por rebaixamento,
 *     nem por remoção. Uma organização sem dono não tem quem gerencie
 *     billing nem quem solicite a exclusão de dados da LGPD.
 */

const memberSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  avatarUrl: z.string().nullable(),
  role: z.enum(ROLES),
  status: z.string(),
  scopedClientIds: z.array(z.string()),
  twoFactorEnabled: z.boolean(),
  acceptedAt: z.string().nullable(),
  lastLoginAt: z.string().nullable(),
});

export async function registerOrganizationRoutes(
  app: AppInstance,
  container: Container,
): Promise<void> {
  const { prisma } = container;
  const authService = new AuthService(container);

  app.get(
    '/organization',
    {
      preHandler: app.requirePermission('org:read'),
      schema: {
        tags: ['Organização'],
        summary: 'Dados da organização atual',
        response: {
          200: z.object({
            id: z.string(),
            name: z.string(),
            slug: z.string(),
            logoUrl: z.string().nullable(),
            timezone: z.string(),
            retention: z.object({
              mediaDays: z.number().nullable(),
              analyticsDays: z.number().nullable(),
              auditLogDays: z.number().nullable(),
            }),
            plan: z
              .object({
                tier: z.string(),
                name: z.string(),
                status: z.string(),
                limits: z.record(z.unknown()),
              })
              .nullable(),
            usage: z.object({
              socialAccounts: z.number(),
              users: z.number(),
              clients: z.number(),
              accountGroups: z.number(),
              storageBytes: z.number(),
            }),
          }),
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);

      const [organization, subscription, accounts, users, clients, groups, storage] =
        await Promise.all([
          prisma.organization.findUniqueOrThrow({ where: { id: auth.organizationId } }),
          prisma.subscription.findUnique({
            where: { organizationId: auth.organizationId },
            include: { plan: true },
          }),
          prisma.socialAccount.count({
            where: { organizationId: auth.organizationId, deletedAt: null },
          }),
          prisma.membership.count({
            where: { organizationId: auth.organizationId, deletedAt: null, status: 'ACTIVE' },
          }),
          prisma.client.count({
            where: { organizationId: auth.organizationId, deletedAt: null },
          }),
          prisma.accountGroup.count({
            where: { organizationId: auth.organizationId, deletedAt: null },
          }),
          prisma.mediaAsset.aggregate({
            where: { organizationId: auth.organizationId, deletedAt: null },
            _sum: { sizeBytes: true },
          }),
        ]);

      return {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        logoUrl: organization.logoUrl,
        timezone: organization.timezone,
        retention: {
          mediaDays: organization.mediaRetentionDays,
          analyticsDays: organization.analyticsRetentionDays,
          auditLogDays: organization.auditLogRetentionDays,
        },
        plan: subscription
          ? {
              tier: subscription.plan.tier,
              name: subscription.plan.name,
              status: subscription.status,
              limits: {
                ...(subscription.plan.limits as Record<string, unknown>),
                ...((subscription.limitOverrides as Record<string, unknown> | null) ?? {}),
              },
            }
          : null,
        usage: {
          socialAccounts: accounts,
          users,
          clients,
          accountGroups: groups,
          storageBytes: Number(storage._sum.sizeBytes ?? 0n),
        },
      };
    },
  );

  app.patch(
    '/organization',
    {
      preHandler: app.requirePermission('org:update'),
      schema: {
        tags: ['Organização'],
        summary: 'Atualiza dados e política de retenção',
        body: z.object({
          name: z.string().min(2).max(120).optional(),
          timezone: z.string().min(1).max(64).optional(),
          logoUrl: z.string().url().nullable().optional(),
          // Retenção de dados (SPEC seção 11). Nulo volta ao padrão do plano.
          mediaRetentionDays: z.number().int().min(1).max(3650).nullable().optional(),
          analyticsRetentionDays: z.number().int().min(1).max(3650).nullable().optional(),
          auditLogRetentionDays: z.number().int().min(30).max(3650).nullable().optional(),
        }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      if (request.body.timezone) assertValidTimezone(request.body.timezone);

      await prisma.organization.update({
        where: { id: auth.organizationId },
        data: request.body,
      });

      await recordAudit(prisma, {
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        action: 'org.update',
        entityType: 'Organization',
        entityId: auth.organizationId,
        changes: request.body,
        correlationId: request.correlationId,
      });

      return reply.status(204).send(null);
    },
  );

  // --- Membros --------------------------------------------------------------
  app.get(
    '/organization/members',
    {
      preHandler: app.requirePermission('org:read'),
      schema: {
        tags: ['Organização'],
        summary: 'Lista os membros e seus papéis',
        response: { 200: z.object({ members: z.array(memberSchema) }) },
      },
    },
    async (request) => {
      const auth = requireAuth(request);

      const memberships = await prisma.membership.findMany({
        where: { organizationId: auth.organizationId, deletedAt: null },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              avatarUrl: true,
              twoFactorEnabled: true,
              lastLoginAt: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      });

      return {
        members: memberships.map((membership) => ({
          userId: membership.user.id,
          name: membership.user.name,
          email: membership.user.email,
          avatarUrl: membership.user.avatarUrl,
          role: membership.role,
          status: membership.status,
          scopedClientIds: membership.scopedClientIds,
          twoFactorEnabled: membership.user.twoFactorEnabled,
          acceptedAt: membership.acceptedAt?.toISOString() ?? null,
          lastLoginAt: membership.user.lastLoginAt?.toISOString() ?? null,
        })),
      };
    },
  );

  app.post(
    '/organization/members/invite',
    {
      preHandler: app.requirePermission('org:manage_members'),
      schema: {
        tags: ['Organização'],
        summary: 'Convida alguém para a organização',
        body: z.object({
          email: z.string().email(),
          role: z.enum(ROLES),
          /** Vazio = acesso a todos os clientes. */
          scopedClientIds: z.array(z.string().uuid()).default([]),
        }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);

      // Só Owner cria outro Owner. Sem isto, um Admin poderia criar um Owner
      // e usá-lo para escalar o próprio acesso.
      if (request.body.role === 'OWNER' && auth.role !== 'OWNER') {
        throw new ForbiddenError('Apenas o proprietário pode convidar outro proprietário.');
      }

      await assertPlanUserLimit(container, auth.organizationId);

      await authService.inviteMember({
        organizationId: auth.organizationId,
        inviterUserId: auth.userId,
        email: request.body.email,
        role: request.body.role,
        scopedClientIds: request.body.scopedClientIds,
        meta: { correlationId: request.correlationId },
      });

      return reply.status(204).send(null);
    },
  );

  app.patch(
    '/organization/members/:userId',
    {
      preHandler: app.requirePermission('org:manage_roles'),
      schema: {
        tags: ['Organização'],
        summary: 'Altera papel e escopo de um membro',
        params: z.object({ userId: z.string().uuid() }),
        body: z.object({
          role: z.enum(ROLES).optional(),
          scopedClientIds: z.array(z.string().uuid()).optional(),
          status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
        }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const targetUserId = request.params.userId;

      if (targetUserId === auth.userId && request.body.role) {
        throw new ForbiddenError(
          'Você não pode alterar o próprio papel. Peça a outro administrador.',
        );
      }
      if (request.body.role === 'OWNER' && auth.role !== 'OWNER') {
        throw new ForbiddenError('Apenas o proprietário pode promover alguém a proprietário.');
      }

      const membership = await prisma.membership.findUnique({
        where: {
          organizationId_userId: { organizationId: auth.organizationId, userId: targetUserId },
        },
      });
      if (!membership || membership.deletedAt) {
        throw new NotFoundError('Membro', targetUserId);
      }

      const losingOwner =
        membership.role === 'OWNER' &&
        ((request.body.role && request.body.role !== 'OWNER') ||
          request.body.status === 'SUSPENDED');

      if (losingOwner) await assertNotLastOwner(container, auth.organizationId, targetUserId);

      await prisma.membership.update({
        where: { id: membership.id },
        data: {
          ...(request.body.role ? { role: request.body.role } : {}),
          ...(request.body.scopedClientIds
            ? { scopedClientIds: request.body.scopedClientIds }
            : {}),
          ...(request.body.status ? { status: request.body.status } : {}),
        },
      });

      // Papel novo só vale no próximo access token (15 min) a menos que as
      // sessões sejam derrubadas. Para rebaixamento e suspensão, derrubamos:
      // uma remoção de acesso precisa valer agora.
      const isDowngrade =
        request.body.status === 'SUSPENDED' ||
        (request.body.role !== undefined &&
          permissionsForRole(request.body.role).size < permissionsForRole(membership.role).size);

      if (isDowngrade) {
        await prisma.session.updateMany({
          where: { userId: targetUserId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }

      await recordAudit(prisma, {
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        action: 'member.role_change',
        entityType: 'Membership',
        entityId: membership.id,
        changes: {
          alvo: targetUserId,
          antes: { role: membership.role, status: membership.status },
          depois: request.body,
          sessoesRevogadas: isDowngrade,
        },
        correlationId: request.correlationId,
      });

      return reply.status(204).send(null);
    },
  );

  app.delete(
    '/organization/members/:userId',
    {
      preHandler: app.requirePermission('org:manage_members'),
      schema: {
        tags: ['Organização'],
        summary: 'Remove um membro da organização',
        params: z.object({ userId: z.string().uuid() }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const targetUserId = request.params.userId;

      if (targetUserId === auth.userId) {
        throw new ForbiddenError('Você não pode remover a si mesmo da organização.');
      }

      const membership = await prisma.membership.findUnique({
        where: {
          organizationId_userId: { organizationId: auth.organizationId, userId: targetUserId },
        },
      });
      if (!membership || membership.deletedAt) throw new NotFoundError('Membro', targetUserId);

      if (membership.role === 'OWNER') {
        await assertNotLastOwner(container, auth.organizationId, targetUserId);
      }

      await prisma.$transaction([
        prisma.membership.update({
          where: { id: membership.id },
          data: { deletedAt: new Date(), status: 'SUSPENDED' },
        }),
        prisma.session.updateMany({
          where: { userId: targetUserId, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
      ]);

      await recordAudit(prisma, {
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        action: 'member.remove',
        entityType: 'Membership',
        entityId: membership.id,
        changes: { alvo: targetUserId, papel: membership.role },
        correlationId: request.correlationId,
      });

      return reply.status(204).send(null);
    },
  );

  // --- Auditoria ------------------------------------------------------------
  app.get(
    '/organization/audit-log',
    {
      preHandler: app.requirePermission('org:view_audit_log'),
      schema: {
        tags: ['Organização'],
        summary: 'Log de auditoria da organização',
        querystring: z.object({
          action: z.string().optional(),
          entityType: z.string().optional(),
          actorUserId: z.string().uuid().optional(),
          from: z.coerce.date().optional(),
          to: z.coerce.date().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: {
          200: z.object({
            entries: z.array(
              z.object({
                id: z.string(),
                action: z.string(),
                entityType: z.string(),
                entityId: z.string().nullable(),
                actorName: z.string().nullable(),
                changes: z.unknown(),
                ipAddress: z.string().nullable(),
                correlationId: z.string().nullable(),
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
      const { limit, offset, from, to, ...filters } = request.query;

      const where = {
        organizationId: auth.organizationId,
        ...(filters.action ? { action: filters.action } : {}),
        ...(filters.entityType ? { entityType: filters.entityType } : {}),
        ...(filters.actorUserId ? { actorUserId: filters.actorUserId } : {}),
        ...(from || to
          ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
          : {}),
      };

      const [entries, total] = await Promise.all([
        prisma.auditLog.findMany({
          where,
          include: { actor: { select: { name: true } } },
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
        }),
        prisma.auditLog.count({ where }),
      ]);

      return {
        entries: entries.map((entry) => ({
          id: entry.id,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId,
          actorName: entry.actor?.name ?? null,
          changes: entry.changes,
          ipAddress: entry.ipAddress,
          correlationId: entry.correlationId,
          createdAt: entry.createdAt.toISOString(),
        })),
        total,
      };
    },
  );

  // --- Exclusão de dados (LGPD) ---------------------------------------------
  app.post(
    '/organization/deletion-request',
    {
      preHandler: app.requirePermission('org:request_data_deletion'),
      schema: {
        tags: ['Organização'],
        summary: 'Solicita a exclusão completa dos dados da organização',
        description:
          'Direito de exclusão da LGPD (SPEC seção 11). O processo revoga os tokens ' +
          'OAuth junto às plataformas ANTES de apagar — apagar o banco primeiro ' +
          'deixaria as autorizações vivas lá fora. Há uma janela de arrependimento.',
        body: z.object({
          reason: z.string().max(1000).optional(),
          /** Dias até o expurgo definitivo. */
          gracePeriodDays: z.number().int().min(1).max(30).default(7),
        }),
        response: {
          201: z.object({
            id: z.string(),
            status: z.string(),
            scheduledFor: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);

      const existing = await prisma.dataDeletionRequest.findFirst({
        where: {
          organizationId: auth.organizationId,
          status: { in: ['PENDING', 'CONFIRMED', 'PROCESSING'] },
        },
      });
      if (existing) {
        throw new ConflictError('Já existe um pedido de exclusão em andamento.');
      }

      const scheduledFor = new Date(
        Date.now() + request.body.gracePeriodDays * 24 * 60 * 60_000,
      );

      const created = await prisma.dataDeletionRequest.create({
        data: {
          organizationId: auth.organizationId,
          requestedById: auth.userId,
          reason: request.body.reason ?? null,
          scheduledFor,
          status: 'PENDING',
        },
      });

      await recordAudit(prisma, {
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        action: 'org.deletion_requested',
        entityType: 'DataDeletionRequest',
        entityId: created.id,
        changes: { scheduledFor: scheduledFor.toISOString() },
        correlationId: request.correlationId,
      });

      return reply.status(201).send({
        id: created.id,
        status: created.status,
        scheduledFor: scheduledFor.toISOString(),
      });
    },
  );

  app.post(
    '/organization/deletion-request/:requestId/cancel',
    {
      preHandler: app.requirePermission('org:request_data_deletion'),
      schema: {
        tags: ['Organização'],
        summary: 'Cancela um pedido de exclusão dentro da janela de arrependimento',
        params: z.object({ requestId: z.string().uuid() }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);

      const updated = await prisma.dataDeletionRequest.updateMany({
        where: {
          id: request.params.requestId,
          organizationId: auth.organizationId,
          status: { in: ['PENDING', 'CONFIRMED'] },
        },
        data: { status: 'CANCELLED' },
      });

      if (updated.count === 0) {
        throw new ValidationError(
          'Pedido não encontrado ou já em processamento — não é mais possível cancelar.',
        );
      }

      await recordAudit(prisma, {
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        action: 'org.deletion_cancelled',
        entityType: 'DataDeletionRequest',
        entityId: request.params.requestId,
        correlationId: request.correlationId,
      });

      return reply.status(204).send(null);
    },
  );
}

// ---------------------------------------------------------------------------

async function assertNotLastOwner(
  container: Container,
  organizationId: string,
  excludingUserId: string,
): Promise<void> {
  const otherOwners = await container.prisma.membership.count({
    where: {
      organizationId,
      role: 'OWNER',
      status: 'ACTIVE',
      deletedAt: null,
      userId: { not: excludingUserId },
    },
  });

  if (otherOwners === 0) {
    throw new ConflictError(
      'Esta é a única pessoa com papel de proprietário. Promova outro membro antes, ' +
        'senão a organização ficaria sem quem gerencie plano e exclusão de dados.',
    );
  }
}

async function assertPlanUserLimit(
  container: Container,
  organizationId: string,
): Promise<void> {
  const subscription = await container.prisma.subscription.findUnique({
    where: { organizationId },
    include: { plan: true },
  });
  if (!subscription) return;

  const limits = {
    ...(subscription.plan.limits as Record<string, unknown>),
    ...((subscription.limitOverrides as Record<string, unknown> | null) ?? {}),
  };
  const max = limits['maxUsers'];
  if (typeof max !== 'number' || max < 0) return;

  const current = await container.prisma.membership.count({
    where: { organizationId, deletedAt: null },
  });

  if (current >= max) {
    throw new ForbiddenError(
      `Seu plano (${subscription.plan.name}) permite até ${max} usuário(s). ` +
        `Remova alguém ou mude de plano para convidar mais.`,
    );
  }
}
