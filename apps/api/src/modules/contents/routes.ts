import { PLATFORM_KEYS } from '@app/core';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { requireAuth } from '../../plugins/auth.js';
import type { AppInstance } from '../../types.js';
import { ContentService } from './service.js';

const contentSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  body: z.string(),
  hashtags: z.array(z.string()),
  aiGenerated: z.boolean(),
  aiReviewedAt: z.string().nullable(),
  clientId: z.string().nullable(),
  campaignId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  media: z.array(
    z.object({
      mediaAssetId: z.string(),
      position: z.number(),
      role: z.string(),
      filename: z.string(),
      type: z.string(),
      mimeType: z.string(),
      processingStatus: z.string(),
      durationMs: z.number().nullable(),
      width: z.number().nullable(),
      height: z.number().nullable(),
    }),
  ),
  variants: z.array(
    z.object({
      id: z.string(),
      platform: z.enum(PLATFORM_KEYS),
      socialAccountId: z.string().nullable(),
      accountNickname: z.string().nullable(),
      title: z.string().nullable(),
      body: z.string().nullable(),
      hashtags: z.array(z.string()),
      platformFields: z.record(z.unknown()),
    }),
  ),
});

export async function registerContentRoutes(
  app: AppInstance,
  container: Container,
): Promise<void> {
  const service = new ContentService(container);

  app.get(
    '/contents',
    {
      preHandler: app.requirePermission('content:read'),
      schema: {
        tags: ['Conteúdo'],
        summary: 'Lista os conteúdos mestres',
        querystring: z.object({
          clientId: z.string().uuid().optional(),
          campaignId: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(30),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: {
          200: z.object({ contents: z.array(contentSchema), total: z.number() }),
        },
      },
    },
    async (request) => service.list(requireAuth(request), request.query),
  );

  app.get(
    '/contents/:contentId',
    {
      preHandler: app.requirePermission('content:read'),
      schema: {
        tags: ['Conteúdo'],
        summary: 'Detalhe do conteúdo, com mídia e variações',
        params: z.object({ contentId: z.string().uuid() }),
        response: { 200: contentSchema },
      },
    },
    async (request) => service.get(requireAuth(request), request.params.contentId),
  );

  app.post(
    '/contents',
    {
      preHandler: app.requirePermission('content:create'),
      schema: {
        tags: ['Conteúdo'],
        summary: 'Cria um conteúdo mestre',
        body: z.object({
          title: z.string().max(300).optional(),
          body: z.string().max(20_000).optional(),
          hashtags: z.array(z.string().max(80)).max(60).optional(),
          clientId: z.string().uuid().optional(),
          campaignId: z.string().uuid().optional(),
          mediaAssetIds: z.array(z.string().uuid()).max(20).optional(),
          aiGenerated: z.boolean().optional(),
        }),
        response: { 201: contentSchema },
      },
    },
    async (request, reply) => {
      const content = await service.create(
        requireAuth(request),
        request.body,
        request.correlationId,
      );
      return reply.status(201).send(content);
    },
  );

  app.patch(
    '/contents/:contentId',
    {
      preHandler: app.requirePermission('content:update'),
      schema: {
        tags: ['Conteúdo'],
        summary: 'Atualiza o conteúdo mestre',
        params: z.object({ contentId: z.string().uuid() }),
        body: z.object({
          title: z.string().max(300).nullable().optional(),
          body: z.string().max(20_000).optional(),
          hashtags: z.array(z.string().max(80)).max(60).optional(),
          clientId: z.string().uuid().nullable().optional(),
          campaignId: z.string().uuid().nullable().optional(),
          mediaAssetIds: z.array(z.string().uuid()).max(20).optional(),
        }),
        response: { 200: contentSchema },
      },
    },
    async (request) =>
      service.update(
        requireAuth(request),
        request.params.contentId,
        request.body,
        request.correlationId,
      ),
  );

  app.put(
    '/contents/:contentId/variants',
    {
      preHandler: app.requirePermission('content:update'),
      schema: {
        tags: ['Conteúdo'],
        summary: 'Define variações por rede e overrides por conta',
        description:
          '`socialAccountId` nulo cria a variação da PLATAFORMA; preenchido cria o ' +
          'override daquela CONTA (ex.: legenda diferente só no TikTok 3). ' +
          'A cascata aplicada na publicação é: override da conta > variação da rede > mestre.',
        params: z.object({ contentId: z.string().uuid() }),
        body: z.object({
          variants: z.array(
            z.object({
              platform: z.enum(PLATFORM_KEYS),
              socialAccountId: z.string().uuid().nullable().optional(),
              title: z.string().max(300).nullable().optional(),
              body: z.string().max(20_000).nullable().optional(),
              hashtags: z.array(z.string().max(80)).max(60).optional(),
              platformFields: z.record(z.unknown()).optional(),
            }),
          ),
        }),
        response: { 200: contentSchema },
      },
    },
    async (request) =>
      service.setVariants(
        requireAuth(request),
        request.params.contentId,
        request.body.variants,
        request.correlationId,
      ),
  );

  app.delete(
    '/contents/:contentId',
    {
      preHandler: app.requirePermission('content:delete'),
      schema: {
        tags: ['Conteúdo'],
        summary: 'Remove um conteúdo (soft-delete)',
        params: z.object({ contentId: z.string().uuid() }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      await service.remove(requireAuth(request), request.params.contentId, request.correlationId);
      return reply.status(204).send(null);
    },
  );
}
