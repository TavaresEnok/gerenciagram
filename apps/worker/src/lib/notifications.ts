import type { WorkerContainer } from '../container.js';

/**
 * Notificações (SPEC seção 6).
 *
 * Grava uma notificação in-app para cada membro da organização que deve saber,
 * e envia e-mail nos eventos que exigem ação (falha, token expirado).
 *
 * Falhar aqui NUNCA derruba a operação que a originou: perder um aviso é
 * ruim, mas marcar uma publicação bem-sucedida como falha porque o SMTP caiu
 * seria pior.
 */

export interface NotifyInput {
  organizationId: string;
  type: string;
  title: string;
  body: string;
  actionUrl?: string;
  metadata?: Record<string, unknown>;
  /** Quando informado, notifica só estes usuários. */
  userIds?: string[];
}

/** Eventos que merecem e-mail além do aviso na interface. */
const EMAIL_TYPES = new Set(['POST_FAILED', 'TOKEN_EXPIRED', 'APPROVAL_PENDING', 'QUOTA_EXCEEDED']);

export async function notify(container: WorkerContainer, input: NotifyInput): Promise<void> {
  try {
    const recipients = input.userIds
      ? input.userIds.map((userId) => ({ userId }))
      : await container.prisma.membership.findMany({
          where: {
            organizationId: input.organizationId,
            status: 'ACTIVE',
            deletedAt: null,
            // Só quem pode agir sobre o problema. Notificar Viewer e Analyst
            // sobre falha de publicação é ruído que faz todo mundo ignorar.
            role: { in: ['OWNER', 'ADMIN', 'MANAGER'] },
          },
          select: { userId: true },
        });

    if (recipients.length === 0) return;

    await container.prisma.notification.createMany({
      data: recipients.map((recipient) => ({
        organizationId: input.organizationId,
        userId: recipient.userId,
        type: input.type,
        title: input.title,
        body: input.body,
        actionUrl: input.actionUrl ?? null,
        metadata: (input.metadata ?? {}) as object,
        channel: 'IN_APP' as const,
      })),
    });

    if (!EMAIL_TYPES.has(input.type)) return;

    const users = await container.prisma.user.findMany({
      where: {
        id: { in: recipients.map((recipient) => recipient.userId) },
        deletedAt: null,
        emailVerified: { not: null },
      },
      select: { email: true },
    });

    const link = input.actionUrl
      ? `${container.env.WEB_PUBLIC_URL.replace(/\/$/, '')}${input.actionUrl}`
      : container.env.WEB_PUBLIC_URL;

    await Promise.allSettled(
      users.map((user) =>
        container.mailer.send({
          to: user.email,
          subject: input.title,
          text: `${input.body}\n\n${link}`,
        }),
      ),
    );
  } catch (error) {
    container.logger.error(
      { err: error, type: input.type, organizationId: input.organizationId },
      'não foi possível registrar a notificação',
    );
  }
}
