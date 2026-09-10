import { ConflictError, NotFoundError } from '@app/core';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { recordAudit } from '../../lib/audit.js';
import { requireAuth } from '../../plugins/auth.js';
import type { AppInstance } from '../../types.js';

/**
 * Workflow de aprovação (SPEC seções 6 e 12).
 *
 * A separação que dá sentido ao módulo: quem CRIA conteúdo (Editor) não
 * aprova, e quem APROVA (Approver) não agenda. Um post rejeitado volta para
 * rascunho com o motivo — não some nem fica num limbo sem estado.
 *
 * Aprovar NÃO publica: só libera o post para ser agendado. Juntar as duas
 * coisas tiraria do gestor a decisão de quando o conteúdo sai.
 */

const commentSchema = z.object({
  id: z.string(),
  body: z.string(),
  authorName: z.string().nullable(),
  isInternal: z.boolean(),
  createdAt: z.string(),
});

const approvalSchema = z.object({
  id: z.string(),
  postId: z.string(),
  status: z.string(),
  decidedAt: z.string().nullable(),
  decidedByName: z.string().nullable(),
  decisionNote: z.string().nullable(),
  createdAt: z.string(),
  post: z.object({
    id: z.string(),
    status: z.string(),
    contentTitle: z.string().nullable(),
    contentBody: z.string(),
    targetCount: z.number(),
    intendedScheduledAt: z.string().nullable(),
  }),
  comments: z.array(commentSchema),
});

export async function registerApprovalRoutes(
  app: AppInstance,
  container: Container,
): Promise<void> {
  const { prisma } = container;

  const include = {
    decidedBy: { select: { name: true } },
    comments: {
      where: { deletedAt: null },
      include: { author: { select: { name: true } } },
      orderBy: { createdAt: 'asc' as const },
    },
    post: {
      select: {
        id: true,
        status: true,
        intendedScheduledAt: true,
        content: { select: { title: true, body: true } },
        _count: { select: { targets: { where: { deletedAt: null } } } },
      },
    },
  };

  type ApprovalRow = Awaited<
    ReturnType<typeof prisma.approval.findFirstOrThrow<{ include: typeof include }>>
  >;

  const toView = (approval: ApprovalRow) => ({
    id: approval.id,
    postId: approval.postId,
    status: approval.status,
    decidedAt: approval.decidedAt?.toISOString() ?? null,
    decidedByName: approval.decidedBy?.name ?? null,
    decisionNote: approval.decisionNote,
    createdAt: approval.createdAt.toISOString(),
    post: {
      id: approval.post.id,
      status: approval.post.status,
      contentTitle: approval.post.content.title,
      contentBody: approval.post.content.body.slice(0, 1000),
      targetCount: approval.post._count.targets,
      intendedScheduledAt: approval.post.intendedScheduledAt?.toISOString() ?? null,
    },
    comments: approval.comments.map((comment) => ({
      id: comment.id,
      body: comment.body,
      authorName: comment.author?.name ?? null,
      isInternal: comment.isInternal,
      createdAt: comment.createdAt.toISOString(),
    })),
  });

  app.get(
    '/approvals',
    {
      preHandler: app.requirePermission('approval:read'),
      schema: {
        tags: ['Aprovações'],
        summary: 'Fila de conteúdo aguardando revisão',
        querystring: z.object({
          status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CHANGES_REQUESTED']).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: {
          200: z.object({ approvals: z.array(approvalSchema), total: z.number() }),
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);

      const where = {
        organizationId: auth.organizationId,
        ...(request.query.status ? { status: request.query.status } : {}),
      };

      const [approvals, total] = await Promise.all([
        prisma.approval.findMany({
          where,
          include,
          orderBy: { createdAt: 'asc' },
          take: request.query.limit,
          skip: request.query.offset,
        }),
        prisma.approval.count({ where }),
      ]);

      return { approvals: approvals.map(toView), total };
    },
  );

  app.post(
    '/posts/:postId/request-approval',
    {
      preHandler: app.requirePermission('approval:request'),
      schema: {
        tags: ['Aprovações'],
        summary: 'Envia a publicação para revisão',
        params: z.object({ postId: z.string().uuid() }),
        body: z.object({ note: z.string().max(2000).optional() }).optional().default({}),
        response: { 201: approvalSchema },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);

      const post = await prisma.post.findFirst({
        where: {
          id: request.params.postId,
          organizationId: auth.organizationId,
          deletedAt: null,
        },
        include: { approval: true },
      });
      if (!post) throw new NotFoundError('Publicação', request.params.postId);

      if (post.status === 'PUBLISHED' || post.status === 'PUBLISHING') {
        throw new ConflictError('Esta publicação já saiu — não há o que aprovar.');
      }
      if (post.approval && post.approval.status === 'PENDING') {
        throw new ConflictError('Esta publicação já está aguardando aprovação.');
      }

      const approval = await prisma.approval.upsert({
        where: { postId: post.id },
        create: {
          organizationId: auth.organizationId,
          postId: post.id,
          status: 'PENDING',
          requestedById: auth.userId,
          ...(request.body?.note
            ? {
                comments: {
                  create: {
                    organizationId: auth.organizationId,
                    authorId: auth.userId,
                    body: request.body.note,
                  },
                },
              }
            : {}),
        },
        // Reenvio depois de "mudanças solicitadas": zera a decisão anterior,
        // preservando os comentários — é o histórico da conversa.
        update: {
          status: 'PENDING',
          requestedById: auth.userId,
          decidedById: null,
          decidedAt: null,
          decisionNote: null,
        },
        include,
      });

      await prisma.post.update({ where: { id: post.id }, data: { status: 'IN_REVIEW' } });

      await notifyApprovers(container, auth.organizationId, post.id);

      await recordAudit(prisma, {
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        action: 'approval.requested',
        entityType: 'Approval',
        entityId: approval.id,
        correlationId: request.correlationId,
      });

      return reply.status(201).send(toView(approval));
    },
  );

  app.post(
    '/approvals/:approvalId/decide',
    {
      preHandler: app.requirePermission('approval:decide'),
      schema: {
        tags: ['Aprovações'],
        summary: 'Aprova, rejeita ou pede alterações',
        description:
          'Aprovar libera a publicação para ser agendada — NÃO publica. Quando agendar ' +
          'continua sendo decisão de quem tem a permissão de agendamento.',
        params: z.object({ approvalId: z.string().uuid() }),
        body: z.object({
          decision: z.enum(['APPROVED', 'REJECTED', 'CHANGES_REQUESTED']),
          note: z.string().max(2000).optional(),
        }),
        response: { 200: approvalSchema },
      },
    },
    async (request) => {
      const auth = requireAuth(request);

      const approval = await prisma.approval.findFirst({
        where: { id: request.params.approvalId, organizationId: auth.organizationId },
        include: { post: { select: { id: true, createdById: true, status: true } } },
      });
      if (!approval) throw new NotFoundError('Aprovação', request.params.approvalId);

      if (approval.status !== 'PENDING') {
        throw new ConflictError(`Esta aprovação já foi decidida (${approval.status}).`);
      }

      // Quem criou não aprova o próprio conteúdo: seria o mesmo que não ter
      // workflow. Owner/Admin ficam de fora da regra para não travar equipes
      // pequenas onde a mesma pessoa faz os dois papéis.
      if (
        approval.post.createdById === auth.userId &&
        auth.role !== 'OWNER' &&
        auth.role !== 'ADMIN'
      ) {
        throw new ConflictError(
          'Você não pode aprovar o conteúdo que você mesmo criou. Peça a outra pessoa.',
        );
      }

      const postStatus =
        request.body.decision === 'APPROVED'
          ? 'APPROVED'
          : request.body.decision === 'REJECTED'
            ? 'CANCELLED'
            : 'DRAFT';

      const [updated] = await prisma.$transaction([
        prisma.approval.update({
          where: { id: approval.id },
          data: {
            status: request.body.decision,
            decidedById: auth.userId,
            decidedAt: new Date(),
            decisionNote: request.body.note ?? null,
            ...(request.body.note
              ? {
                  comments: {
                    create: {
                      organizationId: auth.organizationId,
                      authorId: auth.userId,
                      body: request.body.note,
                    },
                  },
                }
              : {}),
          },
          include,
        }),
        prisma.post.update({
          where: { id: approval.postId },
          data: { status: postStatus as never },
        }),
      ]);

      // Rejeitar cancela os agendamentos pendentes: deixá-los vivos faria o
      // conteúdo rejeitado sair mesmo assim.
      if (request.body.decision === 'REJECTED') {
        await prisma.postTarget.updateMany({
          where: {
            postId: approval.postId,
            status: { in: ['PENDING', 'SCHEDULED', 'QUEUED'] },
          },
          data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
            errorCode: 'APPROVAL_REJECTED',
            errorMessage: 'A publicação foi rejeitada na revisão.',
          },
        });
      }

      await recordAudit(prisma, {
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        action: `approval.${request.body.decision.toLowerCase()}`,
        entityType: 'Approval',
        entityId: approval.id,
        changes: { postId: approval.postId, nota: request.body.note },
        correlationId: request.correlationId,
      });

      return toView(updated);
    },
  );

  app.post(
    '/approvals/:approvalId/comments',
    {
      preHandler: app.requirePermission('approval:comment'),
      schema: {
        tags: ['Aprovações'],
        summary: 'Adiciona um comentário interno à revisão',
        description: 'Comentário interno NUNCA vai para a rede social.',
        params: z.object({ approvalId: z.string().uuid() }),
        body: z.object({ body: z.string().min(1).max(4000) }),
        response: { 201: commentSchema },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);

      const approval = await prisma.approval.findFirst({
        where: { id: request.params.approvalId, organizationId: auth.organizationId },
        select: { id: true },
      });
      if (!approval) throw new NotFoundError('Aprovação', request.params.approvalId);

      const comment = await prisma.approvalComment.create({
        data: {
          approvalId: approval.id,
          organizationId: auth.organizationId,
          authorId: auth.userId,
          body: request.body.body,
          isInternal: true,
        },
        include: { author: { select: { name: true } } },
      });

      return reply.status(201).send({
        id: comment.id,
        body: comment.body,
        authorName: comment.author?.name ?? null,
        isInternal: comment.isInternal,
        createdAt: comment.createdAt.toISOString(),
      });
    },
  );
}

async function notifyApprovers(
  container: Container,
  organizationId: string,
  postId: string,
): Promise<void> {
  const approvers = await container.prisma.membership.findMany({
    where: {
      organizationId,
      status: 'ACTIVE',
      deletedAt: null,
      role: { in: ['OWNER', 'ADMIN', 'MANAGER', 'APPROVER'] },
    },
    select: { userId: true },
  });

  if (approvers.length === 0) return;

  await container.prisma.notification.createMany({
    data: approvers.map((approver) => ({
      organizationId,
      userId: approver.userId,
      type: 'APPROVAL_PENDING',
      title: 'Conteúdo aguardando sua aprovação',
      body: 'Uma publicação foi enviada para revisão.',
      actionUrl: `/aprovacoes?post=${postId}`,
    })),
  });
}
