import { PLATFORM_KEYS } from '@app/core';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { requireAuth } from '../../plugins/auth.js';
import type { AppInstance } from '../../types.js';
import { PostQueryService } from './query.js';
import { PostService } from './service.js';

const issueSchema = z.object({
  code: z.string(),
  severity: z.string(),
  message: z.string(),
  field: z.string().optional(),
});

const previewTargetSchema = z.object({
  accountId: z.string(),
  nickname: z.string(),
  remoteDisplayName: z.string().nullable(),
  platform: z.enum(PLATFORM_KEYS),
  platformName: z.string(),
  timezone: z.string(),
  accountStatus: z.string(),
  scheduledAt: z.string().nullable(),
  scheduledAtLocal: z.string().nullable(),
  title: z.string().nullable(),
  body: z.string(),
  hashtags: z.array(z.string()),
  platformFields: z.record(z.unknown()),
  issues: z.array(issueSchema),
  canSchedule: z.boolean(),
});

const previewSchema = z.object({
  targets: z.array(previewTargetSchema),
  excluded: z.array(
    z.object({ accountId: z.string(), nickname: z.string(), reason: z.string() }),
  ),
  allValid: z.boolean(),
  timezoneDiverges: z.boolean(),
  summary: z.object({
    total: z.number(),
    schedulable: z.number(),
    blocked: z.number(),
    warnings: z.number(),
  }),
});

const selectionSchema = z.object({
  groupIds: z.array(z.string().uuid()).optional(),
  accountIds: z.array(z.string().uuid()).optional(),
});

const scheduleSchema = z.object({
  mode: z.enum(['SPECIFIC_TIME', 'QUEUE_SLOT']),
  /** Hora LOCAL, interpretada no fuso de cada conta de destino. */
  localDateTime: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'use o formato AAAA-MM-DDTHH:MM')
    .optional(),
  perAccount: z
    .array(
      z.object({
        accountId: z.string().uuid(),
        localDateTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
      }),
    )
    .optional(),
  /** Espaçamento em minutos entre publicações em contas diferentes (anti-spam fan-out). */
  staggerMinutes: z.number().int().min(0).max(180).optional(),
});

const targetViewSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  accountNickname: z.string(),
  remoteDisplayName: z.string().nullable(),
  platform: z.enum(PLATFORM_KEYS),
  platformName: z.string(),
  status: z.string(),
  scheduledAt: z.string().nullable(),
  scheduledAtLocal: z.string().nullable(),
  timezone: z.string(),
  attempts: z.number(),
  maxAttempts: z.number(),
  remoteId: z.string().nullable(),
  remoteUrl: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  errorPermanent: z.boolean(),
  publishedAt: z.string().nullable(),
  issues: z.array(issueSchema),
});

const postSchema = z.object({
  id: z.string(),
  status: z.string(),
  scheduleMode: z.string(),
  intendedScheduledAt: z.string().nullable(),
  createdAt: z.string(),
  publishedAt: z.string().nullable(),
  clientId: z.string().nullable(),
  clientName: z.string().nullable(),
  campaignId: z.string().nullable(),
  campaignName: z.string().nullable(),
  sourceGroupIds: z.array(z.string()),
  content: z.object({
    id: z.string(),
    title: z.string().nullable(),
    body: z.string(),
    mediaCount: z.number(),
    firstMediaType: z.string().nullable(),
  }),
  targets: z.array(targetViewSchema),
  counts: z.object({
    total: z.number(),
    published: z.number(),
    failed: z.number(),
    pending: z.number(),
    cancelled: z.number(),
  }),
});

export async function registerPostRoutes(
  app: AppInstance,
  container: Container,
): Promise<void> {
  const service = new PostService(container);
  const query = new PostQueryService(container);

  // --- Preview --------------------------------------------------------------
  app.post(
    '/posts/preview',
    {
      preHandler: app.requirePermission('post:create'),
      schema: {
        tags: ['Publicações'],
        summary: 'Resolve os destinos e valida cada um, sem agendar nada',
        description:
          'É a tela de confirmação exigida pela SPEC seção 6.1: mostra a lista resolvida ' +
          'conta por conta, com o nome real de cada perfil, o horário no fuso DAQUELA ' +
          'conta e o resultado da validação (mídia, cota, conteúdo duplicado e campos ' +
          'obrigatórios da rede).',
        body: z.object({
          contentId: z.string().uuid(),
          selection: selectionSchema,
          schedule: scheduleSchema.optional(),
        }),
        response: { 200: previewSchema },
      },
    },
    async (request) => service.preview(requireAuth(request), request.body),
  );

  // --- Criação e agendamento ------------------------------------------------
  app.post(
    '/posts',
    {
      preHandler: app.requirePermission('post:create'),
      schema: {
        tags: ['Publicações'],
        summary: 'Cria a publicação e um destino por conta',
        description:
          'Envie o header `Idempotency-Key` para que um reenvio da mesma requisição ' +
          'devolva a mesma publicação em vez de criar outra (SPEC seção 2).',
        headers: z.object({ 'idempotency-key': z.string().min(8).max(200).optional() }),
        body: z.object({
          contentId: z.string().uuid(),
          selection: selectionSchema,
          schedule: scheduleSchema.optional(),
          campaignId: z.string().uuid().optional(),
          /** Agenda os destinos válidos, ignorando os bloqueados. */
          allowPartial: z.boolean().default(false),
        }),
        response: {
          201: z.object({
            postId: z.string(),
            scheduled: z.number(),
            skipped: z.number(),
            preview: previewSchema,
          }),
        },
      },
    },
    async (request, reply) => {
      const idempotencyKey = request.headers['idempotency-key'];

      const result = await service.create(
        requireAuth(request),
        {
          ...request.body,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        },
        request.correlationId,
      );

      return reply.status(201).send(result);
    },
  );

  app.post(
    '/posts/:postId/duplicate',
    {
      preHandler: app.requirePermission('post:create'),
      schema: {
        tags: ['Publicações'],
        summary: 'Reaproveita uma publicação em outra data e/ou outras contas',
        description:
          'Cria uma publicação nova ligada à original por `duplicatedFromId`. Por padrão ' +
          'copia o conteúdo (para que editar a cópia não reescreva o texto do post ' +
          'original) e reaproveita exatamente as contas de destino da origem — não ' +
          'reexpande os grupos, porque isso faria a cópia herdar contas que entraram no ' +
          'grupo depois. A cópia passa pela MESMA validação: duplicar para uma segunda ' +
          'conta do X continua bloqueado pela política de automação daquela rede.',
        params: z.object({ postId: z.string().uuid() }),
        body: z
          .object({
            selection: selectionSchema.optional(),
            schedule: scheduleSchema.optional(),
            campaignId: z.string().uuid().optional(),
            /** Aponta para o mesmo conteúdo em vez de copiá-lo. */
            reuseContent: z.boolean().default(false),
            allowPartial: z.boolean().default(false),
          })
          .optional()
          .default({ reuseContent: false, allowPartial: false }),
        response: {
          201: z.object({
            postId: z.string(),
            contentId: z.string(),
            duplicatedFromId: z.string(),
            scheduled: z.number(),
            skipped: z.number(),
            preview: previewSchema,
          }),
        },
      },
    },
    async (request, reply) => {
      const result = await service.duplicate(
        requireAuth(request),
        request.params.postId,
        request.body ?? {},
        request.correlationId,
      );

      return reply.status(201).send(result);
    },
  );

  app.post(
    '/posts/:postId/schedule',
    {
      preHandler: app.requirePermission('post:schedule'),
      schema: {
        tags: ['Publicações'],
        summary: 'Agenda (ou reagenda) os destinos de uma publicação',
        params: z.object({ postId: z.string().uuid() }),
        body: scheduleSchema,
        response: {
          200: z.object({
            scheduled: z.number(),
            targets: z.array(previewTargetSchema),
          }),
        },
      },
    },
    async (request) =>
      service.schedule(
        requireAuth(request),
        request.params.postId,
        request.body,
        request.correlationId,
      ),
  );

  app.post(
    '/posts/:postId/retry',
    {
      preHandler: app.requirePermission('post:retry'),
      schema: {
        tags: ['Publicações'],
        summary: 'Reprocessa apenas os destinos que falharam',
        description:
          'Num grupo de 20 contas em que 3 falharam, esta ação toca só nas 3. As 17 ' +
          'já publicadas não são republicadas — garantido pela chave única por destino.',
        params: z.object({ postId: z.string().uuid() }),
        body: z
          .object({
            targetIds: z.array(z.string().uuid()).optional(),
            /**
             * Confirmação HUMANA de que os destinos com resultado remoto
             * desconhecido foram conferidos na plataforma e podem ser
             * reenviados (aceitando o risco de duplicação). Sem ela, o
             * reprocessamento desses destinos é recusado com
             * UNVERIFIED_RETRY_REQUIRES_ACK.
             */
            acknowledgeUnverified: z.boolean().optional(),
          })
          .optional()
          .default({}),
        response: {
          200: z.object({
            retried: z.number(),
            resumedVerification: z.number(),
            targets: z.array(
              z.object({ accountNickname: z.string(), scheduledAt: z.string() }),
            ),
          }),
        },
      },
    },
    async (request) =>
      service.retryFailed(
        requireAuth(request),
        request.params.postId,
        request.correlationId,
        request.body?.targetIds,
        { acknowledgeUnverified: request.body?.acknowledgeUnverified },
      ),
  );

  app.post(
    '/posts/:postId/cancel',
    {
      preHandler: app.requirePermission('post:cancel'),
      schema: {
        tags: ['Publicações'],
        summary: 'Cancela destinos ainda não publicados',
        params: z.object({ postId: z.string().uuid() }),
        body: z
          .object({ targetIds: z.array(z.string().uuid()).optional() })
          .optional()
          .default({}),
        response: { 200: z.object({ cancelled: z.number() }) },
      },
    },
    async (request) =>
      service.cancel(
        requireAuth(request),
        request.params.postId,
        request.correlationId,
        request.body?.targetIds,
      ),
  );

  // --- Mudança de grupo aplicada a agendamentos futuros ----------------------
  app.post(
    '/groups/:groupId/apply-to-future',
    {
      preHandler: app.requirePermission('post:schedule'),
      schema: {
        tags: ['Grupos de contas'],
        summary: 'Aplica a composição atual do grupo aos agendamentos futuros',
        description:
          'Ação EXPLÍCITA. Mudar um grupo nunca altera agendamento existente sozinho ' +
          '(SPEC seção 6.1). Use `dryRun` para obter o preview do que mudaria.',
        params: z.object({ groupId: z.string().uuid() }),
        body: z.object({ dryRun: z.boolean().default(true) }),
        response: {
          200: z.object({
            applied: z.boolean(),
            posts: z.array(
              z.object({
                postId: z.string(),
                contentTitle: z.string().nullable(),
                toAdd: z.array(z.string()),
                toRemove: z.array(z.string()),
              }),
            ),
          }),
        },
      },
    },
    async (request) =>
      service.applyGroupChangeToFuture(
        requireAuth(request),
        request.params.groupId,
        request.correlationId,
        request.body.dryRun,
      ),
  );

  // --- Consultas ------------------------------------------------------------
  app.get(
    '/posts',
    {
      preHandler: app.requirePermission('post:read'),
      schema: {
        tags: ['Publicações'],
        summary: 'Lista publicações para o calendário e para a fila',
        querystring: z.object({
          from: z.coerce.date().optional(),
          to: z.coerce.date().optional(),
          status: z.string().optional(),
          groupId: z.string().uuid().optional(),
          accountId: z.string().uuid().optional(),
          clientId: z.string().uuid().optional(),
          campaignId: z.string().uuid().optional(),
          platform: z.enum(PLATFORM_KEYS).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: {
          200: z.object({
            posts: z.array(postSchema),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
        },
      },
    },
    async (request) => {
      const { status, ...rest } = request.query;

      const result = await query.list(requireAuth(request), {
        ...rest,
        ...(status ? { status: status.split(',').map((value) => value.trim()) } : {}),
      });

      return { ...result, limit: rest.limit, offset: rest.offset };
    },
  );

  app.get(
    '/posts/:postId',
    {
      preHandler: app.requirePermission('post:read'),
      schema: {
        tags: ['Publicações'],
        summary: 'Detalhe da publicação com o estado de cada destino',
        params: z.object({ postId: z.string().uuid() }),
        response: { 200: postSchema },
      },
    },
    async (request) => query.get(requireAuth(request), request.params.postId),
  );

  app.get(
    '/dashboard',
    {
      preHandler: app.requirePermission('post:read'),
      schema: {
        tags: ['Publicações'],
        summary: 'Resumo para o painel inicial',
        response: {
          200: z.object({
            accounts: z.object({
              total: z.number(),
              needingReconnect: z.number(),
              byPlatform: z.record(z.number()),
            }),
            posts: z.object({
              published7d: z.number(),
              scheduled: z.number(),
              failed: z.number(),
              awaitingApproval: z.number(),
            }),
            queue: z.object({
              nextPublications: z.array(
                z.object({
                  postId: z.string(),
                  accountNickname: z.string(),
                  scheduledAtLocal: z.string(),
                }),
              ),
            }),
          }),
        },
      },
    },
    async (request) => query.dashboard(requireAuth(request)),
  );
}
