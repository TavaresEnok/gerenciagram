import { ConflictError, ForbiddenError, NotFoundError, assertValidTimezone } from '@app/core';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { recordAudit } from '../../lib/audit.js';
import { requireAuth, type AuthContext } from '../../plugins/auth.js';
import type { AppInstance } from '../../types.js';

/**
 * Clientes/Marcas (SPEC seção 5).
 *
 * O Client é o CONTÊINER DE PERMISSÃO da hierarquia — diferente do grupo de
 * contas, que é só um atalho de seleção. Um membro pode ser restrito a alguns
 * clientes, e essa restrição vale em todas as consultas.
 *
 * Um Client tem N contas por rede. Não existe, em lugar nenhum, a noção de
 * "a conta do Instagram deste cliente".
 */

const clientSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  logoUrl: z.string().nullable(),
  timezone: z.string(),
  notes: z.string().nullable(),
  createdAt: z.string(),
  accountCount: z.number(),
  accountsByPlatform: z.record(z.number()),
});

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'cliente'
  );
}

function assertScope(auth: AuthContext, clientId: string): void {
  if (auth.scopedClientIds.length > 0 && !auth.scopedClientIds.includes(clientId)) {
    throw new ForbiddenError('Seu acesso está limitado a outros clientes desta organização.');
  }
}

export async function registerClientRoutes(
  app: AppInstance,
  container: Container,
): Promise<void> {
  const { prisma } = container;

  app.get(
    '/clients',
    {
      preHandler: app.requirePermission('client:read'),
      schema: {
        tags: ['Clientes'],
        summary: 'Lista os clientes/marcas da organização',
        response: { 200: z.object({ clients: z.array(clientSchema) }) },
      },
    },
    async (request) => {
      const auth = requireAuth(request);

      const clients = await prisma.client.findMany({
        where: {
          organizationId: auth.organizationId,
          deletedAt: null,
          ...(auth.scopedClientIds.length > 0 ? { id: { in: auth.scopedClientIds } } : {}),
        },
        include: {
          socialAccounts: {
            where: { deletedAt: null },
            select: { platform: true },
          },
        },
        orderBy: { name: 'asc' },
      });

      return {
        clients: clients.map((client) => {
          const accountsByPlatform: Record<string, number> = {};
          for (const account of client.socialAccounts) {
            accountsByPlatform[account.platform] =
              (accountsByPlatform[account.platform] ?? 0) + 1;
          }

          return {
            id: client.id,
            name: client.name,
            slug: client.slug,
            logoUrl: client.logoUrl,
            timezone: client.timezone,
            notes: client.notes,
            createdAt: client.createdAt.toISOString(),
            accountCount: client.socialAccounts.length,
            accountsByPlatform,
          };
        }),
      };
    },
  );

  app.post(
    '/clients',
    {
      preHandler: app.requirePermission('client:create'),
      schema: {
        tags: ['Clientes'],
        summary: 'Cria um cliente/marca',
        body: z.object({
          name: z.string().min(1).max(120),
          // Fuso padrão herdado pelas contas deste cliente na conexão.
          timezone: z.string().min(1).max(64).optional(),
          notes: z.string().max(2000).optional(),
          logoUrl: z.string().url().optional(),
        }),
        response: { 201: clientSchema },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);

      if (request.body.timezone) assertValidTimezone(request.body.timezone);

      const organization = await prisma.organization.findUniqueOrThrow({
        where: { id: auth.organizationId },
        select: { timezone: true },
      });

      const baseSlug = slugify(request.body.name);
      let slug = baseSlug;
      for (let attempt = 1; attempt < 50; attempt += 1) {
        const taken = await prisma.client.findUnique({
          where: { organizationId_slug: { organizationId: auth.organizationId, slug } },
        });
        if (!taken) break;
        slug = `${baseSlug}-${attempt + 1}`;
      }

      const created = await prisma.client.create({
        data: {
          organizationId: auth.organizationId,
          name: request.body.name.trim(),
          slug,
          timezone: request.body.timezone ?? organization.timezone,
          notes: request.body.notes ?? null,
          logoUrl: request.body.logoUrl ?? null,
        },
      });

      await recordAudit(prisma, {
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        action: 'client.create',
        entityType: 'Client',
        entityId: created.id,
        changes: { name: created.name, slug: created.slug },
        correlationId: request.correlationId,
      });

      return reply.status(201).send({
        id: created.id,
        name: created.name,
        slug: created.slug,
        logoUrl: created.logoUrl,
        timezone: created.timezone,
        notes: created.notes,
        createdAt: created.createdAt.toISOString(),
        accountCount: 0,
        accountsByPlatform: {},
      });
    },
  );

  app.patch(
    '/clients/:clientId',
    {
      preHandler: app.requirePermission('client:update'),
      schema: {
        tags: ['Clientes'],
        summary: 'Atualiza um cliente/marca',
        params: z.object({ clientId: z.string().uuid() }),
        body: z.object({
          name: z.string().min(1).max(120).optional(),
          timezone: z.string().min(1).max(64).optional(),
          notes: z.string().max(2000).nullable().optional(),
          logoUrl: z.string().url().nullable().optional(),
        }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      assertScope(auth, request.params.clientId);

      if (request.body.timezone) assertValidTimezone(request.body.timezone);

      const existing = await prisma.client.findFirst({
        where: {
          id: request.params.clientId,
          organizationId: auth.organizationId,
          deletedAt: null,
        },
      });
      if (!existing) throw new NotFoundError('Cliente', request.params.clientId);

      await prisma.client.update({
        where: { id: existing.id },
        data: {
          ...(request.body.name ? { name: request.body.name.trim() } : {}),
          ...(request.body.timezone ? { timezone: request.body.timezone } : {}),
          ...(request.body.notes !== undefined ? { notes: request.body.notes } : {}),
          ...(request.body.logoUrl !== undefined ? { logoUrl: request.body.logoUrl } : {}),
        },
      });

      await recordAudit(prisma, {
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        action: 'client.update',
        entityType: 'Client',
        entityId: existing.id,
        changes: { antes: { name: existing.name, timezone: existing.timezone }, depois: request.body },
        correlationId: request.correlationId,
      });

      return reply.status(204).send(null);
    },
  );

  app.delete(
    '/clients/:clientId',
    {
      preHandler: app.requirePermission('client:delete'),
      schema: {
        tags: ['Clientes'],
        summary: 'Remove um cliente/marca (soft-delete)',
        params: z.object({ clientId: z.string().uuid() }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      assertScope(auth, request.params.clientId);

      const client = await prisma.client.findFirst({
        where: {
          id: request.params.clientId,
          organizationId: auth.organizationId,
          deletedAt: null,
        },
        include: {
          socialAccounts: { where: { deletedAt: null }, select: { id: true, nickname: true } },
        },
      });
      if (!client) throw new NotFoundError('Cliente', request.params.clientId);

      // Recusamos apagar um cliente que ainda tem conta conectada: apagar em
      // cascata deixaria tokens ativos na plataforma sem nenhuma tela para
      // revogá-los depois.
      if (client.socialAccounts.length > 0) {
        throw new ConflictError(
          `Este cliente ainda tem ${client.socialAccounts.length} conta(s) conectada(s). ` +
            `Desconecte antes de removê-lo: ` +
            client.socialAccounts.map((a) => a.nickname).join(', '),
        );
      }

      // Soft-delete: relatórios e histórico já emitidos continuam coerentes
      // (SPEC seções 8 e 11).
      await prisma.client.update({
        where: { id: client.id },
        data: { deletedAt: new Date() },
      });

      await recordAudit(prisma, {
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        action: 'client.delete',
        entityType: 'Client',
        entityId: client.id,
        changes: { name: client.name },
        correlationId: request.correlationId,
      });

      return reply.status(204).send(null);
    },
  );
}
