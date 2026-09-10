import {
  NotFoundError,
  PLATFORM_KEYS,
  UnsupportedByPlatformError,
  getPlatformDefinition,
} from '@app/core';
import { getValidCredentials } from '@app/platform';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { adapterContext } from '../../lib/adapter-context.js';
import { recordAudit } from '../../lib/audit.js';
import { requireAuth } from '../../plugins/auth.js';
import type { AppInstance } from '../../types.js';

/**
 * Inbox de comentários e mensagens (SPEC seção 6).
 *
 * A ressalva da especificação vale aqui inteira: "quando a API permitir". O
 * YouTube expõe comentários mas não mensagens diretas; responder exige um
 * escopo que não pedimos por padrão (menor privilégio). Cada limitação vira
 * uma mensagem explícita, nunca um recurso que finge funcionar.
 */

const inboxItemSchema = z.object({
  id: z.string(),
  platform: z.enum(PLATFORM_KEYS),
  platformName: z.string(),
  type: z.string(),
  accountId: z.string(),
  accountNickname: z.string(),
  authorUsername: z.string().nullable(),
  authorAvatarUrl: z.string().nullable(),
  body: z.string(),
  postedAt: z.string(),
  isRead: z.boolean(),
  isReplied: z.boolean(),
  replyBody: z.string().nullable(),
  remotePostId: z.string().nullable(),
});

export async function registerInboxRoutes(
  app: AppInstance,
  container: Container,
): Promise<void> {
  const { prisma } = container;

  app.get(
    '/inbox',
    {
      preHandler: app.requirePermission('inbox:read'),
      schema: {
        tags: ['Inbox'],
        summary: 'Comentários e mensagens centralizados',
        querystring: z.object({
          accountId: z.string().uuid().optional(),
          platform: z.enum(PLATFORM_KEYS).optional(),
          unreadOnly: z.coerce.boolean().default(false),
          limit: z.coerce.number().int().min(1).max(100).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: {
          200: z.object({
            items: z.array(inboxItemSchema),
            total: z.number(),
            /** Redes conectadas cujo inbox não existe por API oficial. */
            unsupportedPlatforms: z.array(
              z.object({ platform: z.enum(PLATFORM_KEYS), reason: z.string() }),
            ),
          }),
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);

      const where = {
        organizationId: auth.organizationId,
        deletedAt: null,
        ...(request.query.accountId ? { socialAccountId: request.query.accountId } : {}),
        ...(request.query.platform ? { platform: request.query.platform } : {}),
        ...(request.query.unreadOnly ? { isRead: false } : {}),
        ...(auth.scopedClientIds.length > 0
          ? { socialAccount: { clientId: { in: auth.scopedClientIds } } }
          : {}),
      };

      const [items, total, accounts] = await Promise.all([
        prisma.comment.findMany({
          where,
          include: { socialAccount: { select: { id: true, nickname: true } } },
          orderBy: { postedAt: 'desc' },
          take: request.query.limit,
          skip: request.query.offset,
        }),
        prisma.comment.count({ where }),
        prisma.socialAccount.findMany({
          where: { organizationId: auth.organizationId, deletedAt: null },
          select: { platform: true },
          distinct: ['platform'],
        }),
      ]);

      // Transparência sobre o que NÃO aparece na lista e por quê.
      const unsupportedPlatforms = accounts
        .filter((account) => {
          const definition = getPlatformDefinition(account.platform);
          return definition.capabilities.readComments.level === 'UNSUPPORTED';
        })
        .map((account) => ({
          platform: account.platform,
          reason:
            `Este recurso não está disponível pela API oficial desta plataforma ` +
            `(${getPlatformDefinition(account.platform).displayName}: ler comentários).`,
        }));

      return {
        items: items.map((item) => ({
          id: item.id,
          platform: item.platform,
          platformName: getPlatformDefinition(item.platform).displayName,
          type: item.type,
          accountId: item.socialAccount.id,
          accountNickname: item.socialAccount.nickname,
          authorUsername: item.authorUsername,
          authorAvatarUrl: item.authorAvatarUrl,
          body: item.body,
          postedAt: item.postedAt.toISOString(),
          isRead: item.isRead,
          isReplied: item.isReplied,
          replyBody: item.replyBody,
          remotePostId: item.remotePostId,
        })),
        total,
        unsupportedPlatforms,
      };
    },
  );

  app.post(
    '/inbox/:itemId/read',
    {
      preHandler: app.requirePermission('inbox:read'),
      schema: {
        tags: ['Inbox'],
        summary: 'Marca um item como lido',
        params: z.object({ itemId: z.string().uuid() }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);

      const updated = await prisma.comment.updateMany({
        where: { id: request.params.itemId, organizationId: auth.organizationId },
        data: { isRead: true },
      });
      if (updated.count === 0) throw new NotFoundError('Item do inbox', request.params.itemId);

      return reply.status(204).send(null);
    },
  );

  app.post(
    '/inbox/:itemId/reply',
    {
      preHandler: app.requirePermission('inbox:reply'),
      schema: {
        tags: ['Inbox'],
        summary: 'Responde a um comentário na plataforma',
        params: z.object({ itemId: z.string().uuid() }),
        body: z.object({ body: z.string().min(1).max(10_000) }),
        response: { 200: z.object({ remoteId: z.string(), repliedAt: z.string() }) },
      },
    },
    async (request) => {
      const auth = requireAuth(request);

      const item = await prisma.comment.findFirst({
        where: {
          id: request.params.itemId,
          organizationId: auth.organizationId,
          deletedAt: null,
        },
        include: { socialAccount: { select: { id: true, nickname: true, platform: true } } },
      });
      if (!item) throw new NotFoundError('Item do inbox', request.params.itemId);

      const adapter = container.adapters.get(item.platform);
      if (!adapter.inbox) {
        throw new UnsupportedByPlatformError(
          getPlatformDefinition(item.platform).displayName,
          'responder comentário',
        );
      }

      await container.circuit.assertClosed(item.platform);

      const ctx = adapterContext(container, request.correlationId, 20_000);
      const { credentials } = await getValidCredentials(
        {
          prisma: container.prisma,
          keyring: container.keyring,
          platforms: container.platforms,
        },
        item.socialAccountId,
        ctx,
      );

      const result = await adapter.inbox.replyToComment(
        credentials,
        item.remoteId,
        request.body.body,
        ctx,
      );

      const repliedAt = new Date();

      await prisma.comment.update({
        where: { id: item.id },
        data: {
          isReplied: true,
          repliedAt,
          replyBody: request.body.body,
          isRead: true,
        },
      });

      await recordAudit(prisma, {
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        action: 'inbox.reply',
        entityType: 'Comment',
        entityId: item.id,
        changes: { conta: item.socialAccount.nickname, remoteId: result.remoteId },
        correlationId: request.correlationId,
      });

      return { remoteId: result.remoteId, repliedAt: repliedAt.toISOString() };
    },
  );
}

// ---------------------------------------------------------------------------

export async function registerNotificationRoutes(
  app: AppInstance,
  container: Container,
): Promise<void> {
  const { prisma } = container;

  app.get(
    '/notifications',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Notificações'],
        summary: 'Notificações do usuário autenticado',
        querystring: z.object({
          unreadOnly: z.coerce.boolean().default(false),
          limit: z.coerce.number().int().min(1).max(100).default(30),
        }),
        response: {
          200: z.object({
            notifications: z.array(
              z.object({
                id: z.string(),
                type: z.string(),
                title: z.string(),
                body: z.string(),
                actionUrl: z.string().nullable(),
                readAt: z.string().nullable(),
                createdAt: z.string(),
              }),
            ),
            unreadCount: z.number(),
          }),
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);

      const [notifications, unreadCount] = await Promise.all([
        prisma.notification.findMany({
          where: {
            userId: auth.userId,
            organizationId: auth.organizationId,
            ...(request.query.unreadOnly ? { readAt: null } : {}),
          },
          orderBy: { createdAt: 'desc' },
          take: request.query.limit,
        }),
        prisma.notification.count({
          where: { userId: auth.userId, organizationId: auth.organizationId, readAt: null },
        }),
      ]);

      return {
        notifications: notifications.map((notification) => ({
          id: notification.id,
          type: notification.type,
          title: notification.title,
          body: notification.body,
          actionUrl: notification.actionUrl,
          readAt: notification.readAt?.toISOString() ?? null,
          createdAt: notification.createdAt.toISOString(),
        })),
        unreadCount,
      };
    },
  );

  app.post(
    '/notifications/read',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Notificações'],
        summary: 'Marca notificações como lidas',
        body: z.object({
          /** Vazio marca todas as não lidas. */
          ids: z.array(z.string().uuid()).optional(),
        }),
        response: { 200: z.object({ marked: z.number() }) },
      },
    },
    async (request) => {
      const auth = requireAuth(request);

      const result = await prisma.notification.updateMany({
        where: {
          userId: auth.userId,
          organizationId: auth.organizationId,
          readAt: null,
          ...(request.body.ids?.length ? { id: { in: request.body.ids } } : {}),
        },
        data: { readAt: new Date() },
      });

      return { marked: result.count };
    },
  );
}
