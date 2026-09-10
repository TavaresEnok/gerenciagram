import { ValidationError } from '@app/core';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { requireAuth } from '../../plugins/auth.js';
import type { AppInstance } from '../../types.js';
import { MediaService } from './service.js';

const mediaSchema = z.object({
  id: z.string(),
  filename: z.string(),
  originalFilename: z.string(),
  mimeType: z.string(),
  type: z.enum(['IMAGE', 'VIDEO', 'DOCUMENT', 'AUDIO']),
  sizeBytes: z.number(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  durationMs: z.number().nullable(),
  processingStatus: z.string(),
  processingError: z.string().nullable(),
  tags: z.array(z.string()),
  folderId: z.string().nullable(),
  clientId: z.string().nullable(),
  version: z.number(),
  createdAt: z.string(),
  url: z.string(),
  thumbnailUrl: z.string().nullable(),
});

export async function registerMediaRoutes(
  app: AppInstance,
  container: Container,
): Promise<void> {
  const service = new MediaService(container);

  app.post(
    '/media',
    {
      preHandler: app.requirePermission('media:upload'),
      schema: {
        tags: ['Mídia'],
        summary: 'Envia um arquivo para a biblioteca',
        description:
          'multipart/form-data com o campo `file`. O tipo é determinado pela assinatura ' +
          'do conteúdo, não pelo Content-Type declarado. Arquivos idênticos (mesmo ' +
          'checksum) são deduplicados.',
        consumes: ['multipart/form-data'],
        response: {
          201: z.object({
            id: z.string(),
            deduplicated: z.boolean(),
            asset: mediaSchema,
          }),
        },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);

      const file = await request.file();
      if (!file) {
        throw new ValidationError('Envie o arquivo no campo "file" (multipart/form-data).');
      }

      // toBuffer() respeita o limite configurado no plugin multipart e lança
      // se estourar — o limite não depende do cliente informar o tamanho.
      const data = await file.toBuffer();

      const fields = file.fields as Record<string, { value?: unknown } | undefined>;
      const readField = (name: string): string | undefined => {
        const raw = fields[name]?.value;
        return typeof raw === 'string' && raw.trim() !== '' ? raw : undefined;
      };

      const tagsRaw = readField('tags');

      const result = await service.upload(
        auth,
        {
          filename: file.filename,
          declaredMimeType: file.mimetype,
          data,
          ...(readField('clientId') ? { clientId: readField('clientId') as string } : {}),
          ...(readField('folderId') ? { folderId: readField('folderId') as string } : {}),
          ...(tagsRaw
            ? { tags: tagsRaw.split(',').map((tag) => tag.trim()).filter(Boolean) }
            : {}),
          ...(readField('replacesAssetId')
            ? { replacesAssetId: readField('replacesAssetId') as string }
            : {}),
        },
        request.correlationId,
      );

      return reply.status(201).send({
        ...result,
        asset: await service.get(auth, result.id),
      });
    },
  );

  app.get(
    '/media',
    {
      preHandler: app.requirePermission('media:read'),
      schema: {
        tags: ['Mídia'],
        summary: 'Lista os arquivos da biblioteca',
        querystring: z.object({
          folderId: z.string().uuid().optional(),
          /** `raiz` filtra só o que está fora de qualquer pasta. */
          root: z.coerce.boolean().optional(),
          clientId: z.string().uuid().optional(),
          type: z.enum(['IMAGE', 'VIDEO', 'DOCUMENT', 'AUDIO']).optional(),
          tag: z.string().optional(),
          search: z.string().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: {
          200: z.object({
            assets: z.array(mediaSchema),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const { root, ...rest } = request.query;

      const result = await service.list(auth, {
        ...rest,
        ...(root ? { folderId: null } : rest.folderId ? { folderId: rest.folderId } : {}),
      });

      return { ...result, limit: rest.limit, offset: rest.offset };
    },
  );

  app.get(
    '/media/:assetId',
    {
      preHandler: app.requirePermission('media:read'),
      schema: {
        tags: ['Mídia'],
        summary: 'Detalhe de um arquivo (com URL assinada temporária)',
        params: z.object({ assetId: z.string().uuid() }),
        response: { 200: mediaSchema },
      },
    },
    async (request) => service.get(requireAuth(request), request.params.assetId),
  );

  app.patch(
    '/media/:assetId',
    {
      preHandler: app.requirePermission('media:update'),
      schema: {
        tags: ['Mídia'],
        summary: 'Atualiza tags, pasta ou cliente do arquivo',
        params: z.object({ assetId: z.string().uuid() }),
        body: z.object({
          tags: z.array(z.string().max(50)).max(30).optional(),
          folderId: z.string().uuid().nullable().optional(),
          clientId: z.string().uuid().nullable().optional(),
        }),
        response: { 200: mediaSchema },
      },
    },
    async (request) =>
      service.update(
        requireAuth(request),
        request.params.assetId,
        request.body,
        request.correlationId,
      ),
  );

  app.delete(
    '/media/:assetId',
    {
      preHandler: app.requirePermission('media:delete'),
      schema: {
        tags: ['Mídia'],
        summary: 'Remove um arquivo (soft-delete)',
        params: z.object({ assetId: z.string().uuid() }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      await service.remove(requireAuth(request), request.params.assetId, request.correlationId);
      return reply.status(204).send(null);
    },
  );

  // --- Pastas ---------------------------------------------------------------
  app.get(
    '/media-folders',
    {
      preHandler: app.requirePermission('media:read'),
      schema: {
        tags: ['Mídia'],
        summary: 'Lista as pastas da biblioteca',
        response: {
          200: z.object({
            folders: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                path: z.string(),
                parentId: z.string().nullable(),
                assetCount: z.number(),
              }),
            ),
          }),
        },
      },
    },
    async (request) => ({ folders: await service.listFolders(requireAuth(request)) }),
  );

  app.post(
    '/media-folders',
    {
      preHandler: app.requirePermission('media:upload'),
      schema: {
        tags: ['Mídia'],
        summary: 'Cria uma pasta',
        body: z.object({
          name: z.string().min(1).max(80),
          parentId: z.string().uuid().optional(),
        }),
        response: {
          201: z.object({
            id: z.string(),
            name: z.string(),
            path: z.string(),
            parentId: z.string().nullable(),
          }),
        },
      },
    },
    async (request, reply) => {
      const folder = await service.createFolder(
        requireAuth(request),
        request.body,
        request.correlationId,
      );
      return reply.status(201).send(folder);
    },
  );
}
