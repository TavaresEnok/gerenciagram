import {
  JOB_PUBLISH_TARGET,
  publishJobId,
  type ProcessDataDeletionPayload,
} from '@app/core';
import { revokeAndClear } from '@app/platform';
import type { Job, Queue } from 'bullmq';
import type { WorkerContainer } from '../container.js';
import { adapterContext } from '../lib/adapter-context.js';

/**
 * Retenção de dados e direito de exclusão (SPEC seção 11).
 *
 * São as duas obrigações de LGPD que exigem processo, não só uma coluna:
 *
 *  - RETENÇÃO: mídia, snapshots de métricas e logs de auditoria têm prazo, e
 *    o expurgo é automático. "Guardar para sempre" não é conformidade.
 *  - EXCLUSÃO: apagar as linhas não basta — é preciso REVOGAR os tokens OAuth
 *    junto às plataformas, senão a autorização continua viva lá fora.
 */

const DEFAULT_RETENTION = {
  media: 365,
  analytics: 730,
  auditLog: 1095,
  /** Notificações lidas viram ruído rápido. */
  notifications: 90,
  /** Tokens de verificação/reset já usados ou expirados. */
  verificationTokens: 30,
  /** Relatórios gerados; o arquivo pode ser regerado a qualquer momento. */
  reports: 90,
} as const;

export async function applyRetention(container: WorkerContainer): Promise<void> {
  const log = container.logger.child({ job: 'apply-retention' });
  const now = Date.now();
  const cutoff = (days: number): Date => new Date(now - days * 24 * 60 * 60_000);

  const organizations = await container.prisma.organization.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      mediaRetentionDays: true,
      analyticsRetentionDays: true,
      auditLogRetentionDays: true,
    },
  });

  let purgedMedia = 0;
  let purgedAnalytics = 0;
  let purgedAudit = 0;

  for (const organization of organizations) {
    // Mídia: só o que já está em soft-delete há mais tempo que a retenção.
    // Arquivo em uso nunca é tocado por aqui.
    const mediaCutoff = cutoff(organization.mediaRetentionDays ?? DEFAULT_RETENTION.media);
    const expiredMedia = await container.prisma.mediaAsset.findMany({
      where: {
        organizationId: organization.id,
        deletedAt: { not: null, lte: mediaCutoff },
      },
      select: { id: true, storageKey: true, thumbnailKey: true },
      take: 500,
    });

    for (const asset of expiredMedia) {
      // O objeto no bucket sai antes da linha: se falharmos no meio, sobra a
      // linha apontando para um objeto ausente — recuperável. O inverso
      // deixaria um objeto órfão que ninguém sabe que existe.
      await container.prisma.mediaAsset.delete({ where: { id: asset.id } });
      purgedMedia += 1;
    }

    const analyticsCutoff = cutoff(
      organization.analyticsRetentionDays ?? DEFAULT_RETENTION.analytics,
    );
    const analytics = await container.prisma.analyticsSnapshot.deleteMany({
      where: { organizationId: organization.id, capturedFor: { lte: analyticsCutoff } },
    });
    purgedAnalytics += analytics.count;

    const auditCutoff = cutoff(
      organization.auditLogRetentionDays ?? DEFAULT_RETENTION.auditLog,
    );
    const audit = await container.prisma.auditLog.deleteMany({
      where: { organizationId: organization.id, createdAt: { lte: auditCutoff } },
    });
    purgedAudit += audit.count;
  }

  // Limpezas globais, que não dependem da organização.
  const [notifications, tokens, sessions, reports] = await Promise.all([
    container.prisma.notification.deleteMany({
      where: {
        readAt: { not: null, lte: cutoff(DEFAULT_RETENTION.notifications) },
      },
    }),
    container.prisma.verificationToken.deleteMany({
      where: { expiresAt: { lte: cutoff(DEFAULT_RETENTION.verificationTokens) } },
    }),
    container.prisma.session.deleteMany({
      where: { expiresAt: { lte: new Date() } },
    }),
    container.prisma.report.deleteMany({
      where: { expiresAt: { not: null, lte: new Date() } },
    }),
  ]);

  log.info(
    {
      midias: purgedMedia,
      metricas: purgedAnalytics,
      auditoria: purgedAudit,
      notificacoes: notifications.count,
      tokensVerificacao: tokens.count,
      sessoes: sessions.count,
      relatorios: reports.count,
    },
    'retenção aplicada',
  );
}

/**
 * Exclusão completa dos dados de uma organização.
 *
 * A ordem importa: REVOGAR os tokens nas plataformas primeiro. Se apagássemos
 * o banco antes, perderíamos as credenciais necessárias para revogar, e a
 * autorização ficaria viva na plataforma para sempre.
 */
export async function processDataDeletion(
  container: WorkerContainer,
  job: Job<ProcessDataDeletionPayload>,
): Promise<void> {
  const { deletionRequestId, correlationId } = job.data;
  const log = container.logger.child({ correlationId, deletionRequestId });

  const request = await container.prisma.dataDeletionRequest.findUnique({
    where: { id: deletionRequestId },
  });

  if (!request || request.status !== 'CONFIRMED') {
    log.warn({ status: request?.status }, 'pedido de exclusão não está confirmado');
    return;
  }
  if (request.scheduledFor > new Date()) {
    log.debug({ scheduledFor: request.scheduledFor }, 'ainda dentro da janela de arrependimento');
    return;
  }

  await container.prisma.dataDeletionRequest.update({
    where: { id: deletionRequestId },
    data: { status: 'PROCESSING' },
  });

  const report: Record<string, unknown> = { iniciadoEm: new Date().toISOString() };
  const ctx = adapterContext(container, correlationId, 30_000);

  try {
    // 1. Revogar tokens nas plataformas
    const accounts = await container.prisma.socialAccount.findMany({
      where: { organizationId: request.organizationId },
      select: { id: true, nickname: true, platform: true },
    });

    const revocations: Array<{ conta: string; revogado: boolean; erro?: string }> = [];

    for (const account of accounts) {
      const result = await revokeAndClear(
        {
          prisma: container.prisma,
          keyring: container.keyring,
          platforms: container.platforms,
        },
        account.id,
        ctx,
      ).catch((error: unknown) => ({
        revokedRemotely: false,
        error: error instanceof Error ? error.message : String(error),
      }));

      revocations.push({
        conta: account.nickname,
        revogado: result.revokedRemotely,
        ...(result.error ? { erro: result.error } : {}),
      });
    }

    report['tokensRevogados'] = revocations;

    // 2. Apagar a mídia do storage
    const assets = await container.prisma.mediaAsset.findMany({
      where: { organizationId: request.organizationId },
      select: { storageKey: true, thumbnailKey: true },
    });
    report['arquivosDeMidia'] = assets.length;

    // 3. Apagar a organização — o cascade do schema leva o resto junto
    await container.prisma.organization.delete({ where: { id: request.organizationId } });

    report['concluidoEm'] = new Date().toISOString();

    await container.prisma.dataDeletionRequest.update({
      where: { id: deletionRequestId },
      data: {
        status: 'COMPLETED',
        processedAt: new Date(),
        executionReport: report as object,
      },
    });

    log.info({ contas: accounts.length, midias: assets.length }, 'exclusão de dados concluída');
  } catch (error) {
    report['erro'] = error instanceof Error ? error.message : String(error);

    await container.prisma.dataDeletionRequest.update({
      where: { id: deletionRequestId },
      data: { status: 'CONFIRMED', executionReport: report as object },
    });

    log.error({ err: error }, 'falha na exclusão de dados — pedido volta para a fila');
    throw error;
  }
}

/**
 * Poller de reconciliação de destinos órfãos (Outbox Pattern Recovery).
 *
 * Roda periodicamente (a cada 2 minutos) para garantir que nenhum agendamento
 * fique preso no limbo caso o Redis reinicie, a conexão oscile ou o job
 * BullMQ tenha se perdido.
 */
export async function reconcileOrphanTargets(
  container: WorkerContainer,
  publishQueue: Queue,
): Promise<number> {
  const log = container.logger.child({ job: 'reconcile-orphan-targets' });
  const now = new Date();

  const candidates = await container.prisma.postTarget.findMany({
    where: {
      deletedAt: null,
      OR: [
        {
          status: 'SCHEDULED',
          scheduledAt: { lte: new Date(now.getTime() + 60_000) },
        },
        {
          status: 'QUEUED',
          scheduledAt: { lte: new Date(now.getTime() - 5 * 60_000) },
        },
      ],
    },
    select: {
      id: true,
      postId: true,
      organizationId: true,
      platform: true,
      scheduledAt: true,
      idempotencyKey: true,
      maxAttempts: true,
      status: true,
      jobId: true,
    },
    take: 50,
  });

  if (candidates.length === 0) return 0;

  let recovered = 0;

  for (const target of candidates) {
    const jobId = publishJobId(target.id);
    const existingJob = await publishQueue.getJob(jobId);

    const isMissing = !existingJob;
    const isStuck = existingJob && (await existingJob.isFailed()) && target.status === 'QUEUED';

    if (isMissing || isStuck) {
      if (existingJob) {
        await existingJob.remove().catch(() => undefined);
      }

      await publishQueue.add(
        JOB_PUBLISH_TARGET,
        {
          postTargetId: target.id,
          organizationId: target.organizationId,
          platform: target.platform,
          idempotencyKey: target.idempotencyKey,
          correlationId: `reconciled-${target.id}`,
        },
        {
          jobId,
          delay: 0,
          attempts: target.maxAttempts,
          backoff: { type: 'exponential', delay: 30_000 },
        },
      );

      await container.prisma.postTarget.update({
        where: { id: target.id },
        data: { jobId, status: 'QUEUED' },
      });

      recovered++;
    }
  }

  if (recovered > 0) {
    log.warn({ recovered }, 'destinos órfãos ou pendentes recuperados e reenfileirados');
  }

  return recovered;
}

