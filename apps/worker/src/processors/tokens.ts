import { TokenExpiredError, type RefreshTokenPayload } from '@app/core';
import { decryptCredentials, refreshCredentials } from '@app/platform';
import type { Job } from 'bullmq';
import type { WorkerContainer } from '../container.js';
import { adapterContext } from '../lib/adapter-context.js';
import { notify } from '../lib/notifications.js';

/**
 * Renovação preventiva de tokens (SPEC seções 6 e 13).
 *
 * Renovar antes de expirar, e não na hora de publicar, é o que evita o modo
 * de falha mais comum: descobrir o token vencido no meio de um upload de
 * vídeo, perdendo o upload inteiro.
 *
 * Quando a renovação falha de forma definitiva, a conta vai para
 * NEEDS_RECONNECT e o usuário é avisado — em vez de as publicações agendadas
 * falharem uma a uma durante a madrugada.
 */

/** Renova tudo que expira nas próximas 2 horas. */
const HORIZON_MS = 2 * 60 * 60_000;

export async function processTokenRefresh(
  container: WorkerContainer,
  job: Job<RefreshTokenPayload>,
): Promise<void> {
  const { socialAccountId, correlationId } = job.data;
  const log = container.logger.child({ correlationId, socialAccountId });

  const account = await container.prisma.socialAccount.findUnique({
    where: { id: socialAccountId },
    include: { oauthToken: true },
  });

  if (!account || account.deletedAt || !account.oauthToken) {
    log.debug('conta sem token — nada a renovar');
    return;
  }
  if (account.oauthToken.revokedAt) {
    log.debug('token revogado — reconexão necessária, nada a renovar');
    return;
  }

  const ctx = adapterContext(container, correlationId, 30_000);
  const credentials = decryptCredentials(account.oauthToken, container.keyring);

  try {
    await refreshCredentials(
      {
        prisma: container.prisma,
        keyring: container.keyring,
        platforms: container.platforms,
      },
      account.id,
      account.organizationId,
      account.platform,
      account.nickname,
      credentials,
      ctx,
    );

    log.info({ platform: account.platform }, 'token renovado preventivamente');
  } catch (error) {
    if (error instanceof TokenExpiredError) {
      await notify(container, {
        organizationId: account.organizationId,
        type: 'TOKEN_EXPIRED',
        title: `Reconecte a conta ${account.nickname}`,
        body:
          `O acesso a "${account.nickname}" expirou ou foi revogado na plataforma. ` +
          `Enquanto não for reconectada, as publicações agendadas para ela não sairão.`,
        actionUrl: `/contas?conta=${account.id}`,
      });

      log.warn({ platform: account.platform }, 'token revogado — conta precisa reconectar');
      return; // não é falha de job: é estado do mundo
    }

    throw error;
  }
}

/**
 * Varredura periódica: enfileira a renovação das contas que estão perto de
 * expirar. Roda como job repetível.
 */
export async function scanExpiringTokens(
  container: WorkerContainer,
  enqueue: (payload: RefreshTokenPayload) => Promise<void>,
): Promise<number> {
  const horizon = new Date(Date.now() + HORIZON_MS);

  const tokens = await container.prisma.oAuthToken.findMany({
    where: {
      revokedAt: null,
      accessTokenExpiresAt: { not: null, lte: horizon },
      socialAccount: { deletedAt: null, status: 'ACTIVE' },
      // Depois de 5 falhas seguidas, parar de tentar: a conta já foi marcada
      // para reconexão e insistir só gera ruído no log.
      refreshFailureCount: { lt: 5 },
    },
    select: { socialAccountId: true, organizationId: true },
    take: 500,
  });

  for (const token of tokens) {
    await enqueue({
      socialAccountId: token.socialAccountId,
      organizationId: token.organizationId,
      correlationId: `token-scan-${Date.now()}`,
    });
  }

  if (tokens.length > 0) {
    container.logger.info({ contas: tokens.length }, 'renovação de tokens enfileirada');
  }

  return tokens.length;
}
