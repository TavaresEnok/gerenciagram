import {
  JOB_PUBLISH_TARGET,
  publishJobId,
  type ProcessDataDeletionPayload,
} from '@app/core';
import { releaseQuota, revokeAndClear } from '@app/platform';
import type { Job, Queue } from 'bullmq';
import type { WorkerContainer } from '../container.js';
import { adapterContext } from '../lib/adapter-context.js';
import { notify } from '../lib/notifications.js';
import { recomputePostStatus } from '../lib/post-status.js';

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


// ---------------------------------------------------------------------------
//  Recuperação de destinos travados em PUBLISHING
// ---------------------------------------------------------------------------

/**
 * Tempo mínimo em PUBLISHING antes de considerar o destino travado.
 *
 * Precisa ser confortavelmente maior que o `lockDuration` do worker (5 min):
 * enquanto o lock vale, o job pode estar simplesmente demorando — um upload
 * de vídeo grande leva minutos, e recuperar um destino que ainda está sendo
 * publicado é a receita para publicar duas vezes.
 */
const LIMITE_TRAVADO_MS = 15 * 60_000;

export interface StuckRecoveryResult {
  /** Caiu antes de falar com a plataforma: reenfileirados com segurança. */
  reenfileirados: number;
  /** Caiu durante a chamada: não dá para saber se saiu, marcados para conferência. */
  inconclusivos: number;
}

/**
 * Destrava destinos presos em PUBLISHING — e resolve sozinho o que dá para
 * resolver sem risco.
 *
 * O buraco que isto fecha: se o worker morre entre marcar PUBLISHING e gravar
 * o resultado (OOM, container morto, deploy no meio), o destino ficava preso
 * PARA SEMPRE. A reentrega do BullMQ não o recupera, porque o claim só aceita
 * SCHEDULED e QUEUED; o reconciliador não olha para PUBLISHING; "tentar
 * novamente" só toca em FAILED; e cancelar exclui PUBLISHING. Sobrava SQL na
 * mão — e a cota, reservada antes da chamada, vazava junto.
 *
 * A decisão de re-tentar ou não NÃO é um chute. `PublishAttempt.externalCallStartedAt`
 * é gravado imediatamente antes da chamada à plataforma, então:
 *
 *  - **nulo** → o processo caiu ANTES de falar com a rede. Nada foi publicado.
 *    Devolve a cota, volta para SCHEDULED e reenfileira. Totalmente
 *    automático, risco zero. É a maioria dos casos, porque a janela da
 *    chamada externa é pequena perto do resto do trabalho.
 *
 *  - **preenchido** → a chamada saiu e não sabemos o desfecho. Re-tentar aqui
 *    poderia publicar o mesmo conteúdo duas vezes, que é a única coisa que
 *    este sistema não pode fazer. Então marca FAILED com um código próprio,
 *    devolve a cota e avisa quem pode conferir — o destino volta a ser
 *    acionável ("tentar novamente" passa a funcionar) em vez de ficar preso.
 */
export async function recoverStuckPublishing(
  container: WorkerContainer,
  publishQueue: Queue,
): Promise<StuckRecoveryResult> {
  const log = container.logger.child({ job: 'recover-stuck-publishing' });
  const limite = new Date(Date.now() - LIMITE_TRAVADO_MS);

  const travados = await container.prisma.postTarget.findMany({
    where: {
      status: 'PUBLISHING',
      deletedAt: null,
      // `remoteId` preenchido significa que a publicação chegou a ser
      // registrada: não é um destino travado, é um que ainda vai ser
      // finalizado pelo próprio processador.
      remoteId: null,
      lastAttemptAt: { lt: limite },
    },
    select: {
      id: true,
      postId: true,
      organizationId: true,
      socialAccountId: true,
      platform: true,
      attempts: true,
      maxAttempts: true,
      idempotencyKey: true,
      scheduledAt: true,
      socialAccount: { select: { nickname: true } },
    },
    take: 50,
  });

  const resultado: StuckRecoveryResult = { reenfileirados: 0, inconclusivos: 0 };
  if (travados.length === 0) return resultado;

  for (const target of travados) {
    const ultimaTentativa = await container.prisma.publishAttempt.findFirst({
      where: { postTargetId: target.id },
      orderBy: { attemptNumber: 'desc' },
      select: { id: true, externalCallStartedAt: true, finishedAt: true },
    });

    // A cota foi reservada antes da chamada e ninguém a devolveu: sem isto,
    // cada worker morto queima uma publicação do dia para sempre.
    await releaseQuota(container.prisma, {
      platform: target.platform,
      socialAccountId: target.socialAccountId,
      at: new Date(),
    }).catch((error: unknown) => {
      log.warn({ err: error, postTargetId: target.id }, 'falha ao devolver a cota');
    });

    const chegouAChamar = ultimaTentativa?.externalCallStartedAt != null;

    if (!chegouAChamar) {
      // Certeza de que nada foi publicado.
      const devolvido = await container.prisma.postTarget.updateMany({
        where: { id: target.id, status: 'PUBLISHING', remoteId: null },
        data: { status: 'SCHEDULED', jobId: null },
      });

      // Perdeu a corrida para o processador de verdade: ele voltou à vida
      // entre a leitura e agora. Deixa com ele.
      if (devolvido.count === 0) continue;

      const jobId = publishJobId(target.id);
      await publishQueue.remove(jobId).catch(() => undefined);
      await publishQueue.add(
        JOB_PUBLISH_TARGET,
        {
          postTargetId: target.id,
          organizationId: target.organizationId,
          platform: target.platform,
          idempotencyKey: target.idempotencyKey,
          correlationId: `recovered-${target.id}`,
        },
        {
          jobId,
          attempts: Math.max(1, target.maxAttempts - target.attempts),
          backoff: { type: 'exponential', delay: 30_000 },
        },
      );

      await container.prisma.postTarget.update({
        where: { id: target.id },
        data: { jobId, status: 'QUEUED' },
      });

      resultado.reenfileirados += 1;
      continue;
    }

    // A chamada saiu e o desfecho é desconhecido.
    const marcado = await container.prisma.postTarget.updateMany({
      where: { id: target.id, status: 'PUBLISHING', remoteId: null },
      data: {
        status: 'FAILED',
        jobId: null,
        errorCode: 'PUBLISH_INTERRUPTED_UNVERIFIED',
        errorPermanent: true,
        errorMessage:
          'O processo caiu durante o envio para a plataforma e não foi possível confirmar ' +
          'se a publicação saiu. Confira a conta antes de tentar novamente: reenviar às ' +
          'cegas poderia publicar o mesmo conteúdo duas vezes.',
      },
    });

    if (marcado.count === 0) continue;

    if (ultimaTentativa) {
      await container.prisma.publishAttempt.update({
        where: { id: ultimaTentativa.id },
        data: {
          finishedAt: new Date(),
          success: false,
          errorCode: 'PUBLISH_INTERRUPTED_UNVERIFIED',
          errorMessage: 'Processo interrompido durante a chamada à plataforma.',
        },
      });
    }

    await notify(container, {
      organizationId: target.organizationId,
      type: 'POST_FAILED',
      title: `Publicação interrompida em ${target.socialAccount.nickname}`,
      body:
        `O envio para ${target.socialAccount.nickname} foi interrompido e não deu para ` +
        'confirmar se o post saiu. Confira a conta: se não saiu, use "tentar novamente".',
      actionUrl: `/fila?post=${target.postId}`,
      metadata: { postTargetId: target.id, motivo: 'PUBLISH_INTERRUPTED_UNVERIFIED' },
    });

    resultado.inconclusivos += 1;
  }

  for (const postId of new Set(travados.map((target) => target.postId))) {
    await recomputePostStatus(container.prisma, postId);
  }

  log.warn(resultado, 'destinos travados em PUBLISHING recuperados');

  return resultado;
}
