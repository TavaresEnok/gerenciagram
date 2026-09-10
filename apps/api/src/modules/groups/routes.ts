import { PLATFORM_KEYS } from '@app/core';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { requireAuth } from '../../plugins/auth.js';
import type { AppInstance } from '../../types.js';
import { GroupService } from './service.js';

const slotSchema = z.object({
  weekday: z.number().int().min(0).max(6),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
});

const memberSchema = z.object({
  accountId: z.string(),
  nickname: z.string(),
  platform: z.enum(PLATFORM_KEYS),
  platformName: z.string(),
  clientId: z.string(),
  clientName: z.string(),
  timezone: z.string(),
  status: z.string(),
  remoteDisplayName: z.string().nullable(),
  remoteAvatarUrl: z.string().nullable(),
});

const groupSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  color: z.string().nullable(),
  memberCount: z.number(),
  countByPlatform: z.record(z.number()),
  members: z.array(memberSchema),
  createdAt: z.string(),
});

export async function registerGroupRoutes(
  app: AppInstance,
  container: Container,
): Promise<void> {
  const service = new GroupService(container);

  app.get(
    '/groups',
    {
      preHandler: app.requirePermission('group:read'),
      schema: {
        tags: ['Grupos de contas'],
        summary: 'Lista os grupos de contas',
        response: { 200: z.object({ groups: z.array(groupSchema) }) },
      },
    },
    async (request) => ({ groups: await service.list(requireAuth(request)) }),
  );

  app.get(
    '/groups/:groupId',
    {
      preHandler: app.requirePermission('group:read'),
      schema: {
        tags: ['Grupos de contas'],
        summary: 'Detalhe de um grupo',
        params: z.object({ groupId: z.string().uuid() }),
        response: { 200: groupSchema },
      },
    },
    async (request) => service.get(requireAuth(request), request.params.groupId),
  );

  app.post(
    '/groups',
    {
      preHandler: app.requirePermission('group:create'),
      schema: {
        tags: ['Grupos de contas'],
        summary: 'Cria um grupo com contas de qualquer rede',
        description:
          'Um grupo pode misturar redes: "Curiosidades" = TikTok 1, TikTok 2, ' +
          'Instagram 1, YouTube 1. Ele é atalho de seleção e não concede permissão.',
        body: z.object({
          name: z.string().min(1).max(120),
          description: z.string().max(1000).optional(),
          color: z.string().max(20).optional(),
          accountIds: z.array(z.string().uuid()).default([]),
        }),
        response: { 201: groupSchema },
      },
    },
    async (request, reply) => {
      const group = await service.create(
        requireAuth(request),
        request.body,
        request.correlationId,
      );
      return reply.status(201).send(group);
    },
  );

  app.patch(
    '/groups/:groupId',
    {
      preHandler: app.requirePermission('group:update'),
      schema: {
        tags: ['Grupos de contas'],
        summary: 'Renomeia ou altera a descrição do grupo',
        params: z.object({ groupId: z.string().uuid() }),
        body: z.object({
          name: z.string().min(1).max(120).optional(),
          description: z.string().max(1000).nullable().optional(),
          color: z.string().max(20).nullable().optional(),
        }),
        response: { 200: groupSchema },
      },
    },
    async (request) =>
      service.update(
        requireAuth(request),
        request.params.groupId,
        request.body,
        request.correlationId,
      ),
  );

  app.put(
    '/groups/:groupId/members',
    {
      preHandler: app.requirePermission('group:update'),
      schema: {
        tags: ['Grupos de contas'],
        summary: 'Define as contas do grupo',
        description:
          'Mudar a composição NÃO altera agendamentos já feitos. A resposta informa ' +
          'quantas publicações futuras vieram deste grupo, para a interface oferecer ' +
          'a ação explícita de aplicar a mudança (SPEC seção 6.1).',
        params: z.object({ groupId: z.string().uuid() }),
        body: z.object({ accountIds: z.array(z.string().uuid()) }),
        response: {
          200: z.object({
            group: groupSchema,
            futureSchedulesAffected: z.number(),
          }),
        },
      },
    },
    async (request) =>
      service.setMembers(
        requireAuth(request),
        request.params.groupId,
        request.body.accountIds,
        request.correlationId,
      ),
  );

  app.delete(
    '/groups/:groupId',
    {
      preHandler: app.requirePermission('group:delete'),
      schema: {
        tags: ['Grupos de contas'],
        summary: 'Remove o grupo (soft-delete)',
        params: z.object({ groupId: z.string().uuid() }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      await service.remove(requireAuth(request), request.params.groupId, request.correlationId);
      return reply.status(204).send(null);
    },
  );

  // --- Resolução de destinos ------------------------------------------------
  app.post(
    '/groups/resolve',
    {
      preHandler: app.requirePermission('account:read'),
      schema: {
        tags: ['Grupos de contas'],
        summary: 'Resolve grupos e contas na lista final de destinos',
        description:
          'Usado pelo compositor para o preview antes de confirmar. Devolve as contas ' +
          'em que o usuário PODE publicar e, separadamente, as que ficaram de fora e por quê.',
        body: z.object({
          groupIds: z.array(z.string().uuid()).optional(),
          accountIds: z.array(z.string().uuid()).optional(),
        }),
        response: {
          200: z.object({
            accounts: z.array(
              z.object({
                accountId: z.string(),
                nickname: z.string(),
                platform: z.enum(PLATFORM_KEYS),
                clientId: z.string(),
                timezone: z.string(),
                status: z.string(),
                remoteDisplayName: z.string().nullable(),
              }),
            ),
            excluded: z.array(
              z.object({
                accountId: z.string(),
                nickname: z.string(),
                reason: z.string(),
              }),
            ),
          }),
        },
      },
    },
    async (request) => service.resolveTargets(requireAuth(request), request.body),
  );

  // --- Grade de horários da fila --------------------------------------------
  app.put(
    '/groups/:groupId/schedule',
    {
      preHandler: app.requirePermission('group:update'),
      schema: {
        tags: ['Grupos de contas'],
        summary: 'Aplica uma grade semanal a todas as contas do grupo',
        description:
          'A grade é gravada em cada conta e interpretada no fuso DELA: o mesmo ' +
          '"segunda às 10h" gera instantes diferentes para contas em fusos diferentes.',
        params: z.object({ groupId: z.string().uuid() }),
        body: z.object({ slots: z.array(slotSchema) }),
        response: {
          200: z.object({
            accountsUpdated: z.number(),
            preview: z.array(
              z.object({
                nickname: z.string(),
                timezone: z.string(),
                slots: z.array(z.string()),
              }),
            ),
          }),
        },
      },
    },
    async (request) =>
      service.applyScheduleToGroup(
        requireAuth(request),
        request.params.groupId,
        request.body.slots,
        request.correlationId,
      ),
  );

  app.put(
    '/accounts/:accountId/schedule',
    {
      preHandler: app.requirePermission('account:update'),
      schema: {
        tags: ['Grupos de contas'],
        summary: 'Define a grade semanal de uma conta específica',
        params: z.object({ accountId: z.string().uuid() }),
        body: z.object({
          slots: z.array(slotSchema),
          isEnabled: z.boolean().default(true),
        }),
        response: {
          200: z.object({ slots: z.array(slotSchema), timezone: z.string() }),
        },
      },
    },
    async (request) =>
      service.setAccountSchedule(
        requireAuth(request),
        request.params.accountId,
        request.body.slots,
        request.body.isEnabled,
        request.correlationId,
      ),
  );
}
