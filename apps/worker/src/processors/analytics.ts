import {
  UnsupportedByPlatformError,
  type AccountMetrics,
  type CollectMetricsPayload,
  type PostMetrics,
} from '@app/core';

/**
 * Valor de  do snapshot que mede a CONTA (e não um post).
 * Ver o comentário da coluna no schema: NULL não serve porque não colide
 * numa UNIQUE do Postgres.
 */
const ACCOUNT_SCOPE_KEY = 'ACCOUNT';
import { getValidCredentials } from '@app/platform';
import type { Job } from 'bullmq';
import type { WorkerContainer } from '../container.js';
import { adapterContext } from '../lib/adapter-context.js';

/**
 * Coleta de métricas (SPEC seção 6, módulo de Analytics).
 *
 * Os snapshots são gravados por (conta, dia) e por (destino, dia). Séries
 * temporais são derivadas deles — guardar só o valor corrente impediria
 * qualquer gráfico de crescimento.
 *
 * Onde a API oficial não entrega uma métrica, o campo fica AUSENTE. Nunca
 * estimamos nem preenchemos com zero: um zero num gráfico é indistinguível de
 * uma queda real (SPEC seção 19).
 */

export async function processCollectMetrics(
  container: WorkerContainer,
  job: Job<CollectMetricsPayload>,
): Promise<void> {
  const { socialAccountId, forDate, correlationId } = job.data;
  const log = container.logger.child({ correlationId, socialAccountId });

  const account = await container.prisma.socialAccount.findUnique({
    where: { id: socialAccountId },
    select: {
      id: true,
      organizationId: true,
      platform: true,
      nickname: true,
      status: true,
      deletedAt: true,
    },
  });

  if (!account || account.deletedAt || account.status !== 'ACTIVE') {
    log.debug('conta indisponível — coleta ignorada');
    return;
  }

  const adapter = container.platforms.adapters.get(account.platform);
  if (!adapter.analytics) {
    // A rede não oferece métricas por API oficial. Sair em silêncio é
    // correto: a UI já mostra a capacidade como indisponível.
    log.debug({ platform: account.platform }, 'plataforma sem API oficial de métricas');
    return;
  }

  await container.circuit.assertClosed(account.platform);

  const ctx = adapterContext(container, correlationId, 30_000);
  const { credentials } = await getValidCredentials(
    { prisma: container.prisma, keyring: container.keyring, platforms: container.platforms },
    socialAccountId,
    ctx,
  );

  const capturedFor = new Date(`${forDate.slice(0, 10)}T00:00:00.000Z`);
  const since = new Date(capturedFor.getTime() - 24 * 60 * 60_000);

  try {
    // --- Métricas da conta ---
    const accountMetrics = await adapter.analytics.fetchAccountMetrics(
      credentials,
      { since, until: capturedFor },
      ctx,
    );

    await container.prisma.analyticsSnapshot.upsert({
      where: {
        socialAccountId_scopeKey_capturedFor: {
          socialAccountId,
          scopeKey: ACCOUNT_SCOPE_KEY,
          capturedFor,
        },
      },
      create: {
        organizationId: account.organizationId,
        socialAccountId,
        scopeKey: ACCOUNT_SCOPE_KEY,
        platform: account.platform,
        capturedFor,
        ...numeric(accountMetrics),
        raw: (accountMetrics.raw ?? {}) as object,
      },
      update: {
        ...numeric(accountMetrics),
        capturedAt: new Date(),
        raw: (accountMetrics.raw ?? {}) as object,
      },
    });

    // --- Métricas dos posts publicados recentemente ---
    const targets = await container.prisma.postTarget.findMany({
      where: {
        socialAccountId,
        status: 'PUBLISHED',
        remoteId: { not: null },
        // 30 dias: depois disso os números mal se mexem e a cota é melhor
        // gasta em posts recentes.
        publishedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60_000) },
        deletedAt: null,
      },
      select: { id: true, remoteId: true },
      take: 200,
    });

    if (targets.length === 0) {
      await container.circuit.onSuccess(account.platform);
      return;
    }

    const remoteIds = targets
      .map((target) => target.remoteId)
      .filter((id): id is string => id !== null);

    const postMetrics = await adapter.analytics.fetchPostMetrics(credentials, remoteIds, ctx);

    for (const target of targets) {
      if (!target.remoteId) continue;
      const metrics = postMetrics.get(target.remoteId);
      if (!metrics) continue;

      await container.prisma.analyticsSnapshot.upsert({
        where: {
          socialAccountId_scopeKey_capturedFor: {
            socialAccountId,
            scopeKey: target.id,
            capturedFor,
          },
        },
        create: {
          organizationId: account.organizationId,
          socialAccountId,
          postTargetId: target.id,
          scopeKey: target.id,
          platform: account.platform,
          capturedFor,
          ...numeric(metrics),
          raw: (metrics.raw ?? {}) as object,
        },
        update: {
          ...numeric(metrics),
          capturedAt: new Date(),
          raw: (metrics.raw ?? {}) as object,
        },
      });
    }

    await container.circuit.onSuccess(account.platform);

    log.info(
      { platform: account.platform, posts: targets.length },
      'métricas coletadas',
    );
  } catch (error) {
    if (error instanceof UnsupportedByPlatformError) {
      log.debug({ platform: account.platform }, 'métrica não suportada pela API oficial');
      return;
    }
    await container.circuit.onFailure(account.platform);
    throw error;
  }
}

/**
 * Só copia os campos que a plataforma realmente devolveu. `undefined` faz o
 * Prisma NÃO gravar a coluna, preservando a diferença entre "zero" e "a API
 * não informa".
 */
function numeric(metrics: AccountMetrics | PostMetrics): Record<string, number | undefined> {
  const keys = [
    'followers',
    'impressions',
    'reach',
    'likes',
    'comments',
    'shares',
    'saves',
    'views',
    'watchTimeSeconds',
    'clicks',
  ] as const;

  const source = metrics as Record<string, unknown>;
  const result: Record<string, number | undefined> = {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
  }
  return result;
}
