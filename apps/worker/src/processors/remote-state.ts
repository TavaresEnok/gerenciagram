import {
  TokenExpiredError,
  checkRemoteJobId,
  isRetryable,
  JOB_CHECK_REMOTE_STATE,
  type CheckRemoteStatePayload,
  type RemotePostState,
} from '@app/core';
import { getValidCredentials } from '@app/platform';
import { Prisma } from '@app/db';
import { DelayedError, type Job, type Queue } from 'bullmq';
import type { WorkerContainer } from '../container.js';
import { adapterContext } from '../lib/adapter-context.js';
import { notify } from '../lib/notifications.js';
import { recomputePostStatus } from '../lib/post-status.js';

/**
 * Verificação de estado remoto pós-envio.
 *
 * Algumas plataformas (TikTok, YouTube, Facebook com vídeo) ACEITAM o envio e
 * processam de forma assíncrona — podendo rejeitar DEPOIS. Marcar PUBLISHED
 * no "aceito" faria a interface anunciar uma publicação que a rede ainda pode
 * derrubar. Este processador é quem transforma "aceito" em desfecho real:
 *
 *  - READY     → o destino vira PUBLISHED, com o id PÚBLICO devolvido pela
 *                plataforma (no TikTok, o publish_id NÃO é o id do post).
 *  - REJECTED  → falha definitiva com o motivo da plataforma. A cota NÃO é
 *                devolvida: o upload já consumiu a janela remota.
 *  - PROCESSING→ o MESMO job é reagendado com `moveToDelayed` + DelayedError
 *                (mecanismo do BullMQ para isto: não consome tentativa e
 *                sobrevive a reinício, porque o job continua no Redis).
 *  - estourou o prazo máximo → o desfecho remoto é DESCONHECIDO. O destino
 *                falha com REMOTE_PROCESSING_TIMEOUT e pede conferência
 *                humana — nunca é anunciado como sucesso.
 *
 * O processador é idempotente: se o destino não está mais PROCESSING (worker
 * reiniciou depois de confirmar, ou um evento repetido chegou), ele sai sem
 * tocar em nada — em particular, sem notificar nem regravar o resultado.
 */

/** Limite do backoff entre consultas: começa em FIRST_POLL e dobra até aqui. */
const MAX_POLL_DELAY_MS = 10 * 60_000;

export function pollDelayMs(firstPollMs: number, attempt: number): number {
  return Math.min(firstPollMs * 2 ** attempt, MAX_POLL_DELAY_MS);
}

const targetSelect = {
  id: true,
  postId: true,
  organizationId: true,
  socialAccountId: true,
  platform: true,
  status: true,
  remoteOperationId: true,
  processingDeadlineAt: true,
  jobId: true,
  deletedAt: true,
  socialAccount: { select: { nickname: true } },
} satisfies Prisma.PostTargetSelect;

type CheckTarget = Prisma.PostTargetGetPayload<{ select: typeof targetSelect }>;

export async function processCheckRemoteState(
  container: WorkerContainer,
  job: Job<CheckRemoteStatePayload>,
): Promise<void> {
  const { postTargetId, correlationId } = job.data;
  const log = container.logger.child({ correlationId, postTargetId, jobId: job.id });

  const target = await container.prisma.postTarget.findUnique({
    where: { id: postTargetId },
    select: targetSelect,
  });

  if (!target || target.deletedAt) return;

  // Evento repetido ou reentrega depois da confirmação: nada a fazer.
  // É este portão que impede uma segunda notificação de sucesso.
  if (target.status !== 'PROCESSING') {
    log.debug({ status: target.status }, 'destino não está mais em processamento — job ignorado');
    return;
  }

  if (!target.remoteOperationId) {
    await failRemote(container, target, 'REMOTE_OPERATION_MISSING',
      'O identificador da operação remota se perdeu e a plataforma não pôde ser consultada. ' +
        'Confira a conta: a publicação pode ter saído.', log);
    return;
  }

  const now = Date.now();
  if (target.processingDeadlineAt && now > target.processingDeadlineAt.getTime()) {
    await markRemoteProcessingTimeout(container, target, log);
    return;
  }

  const adapter = container.platforms.adapters.get(target.platform);
  const ctx = adapterContext(container, correlationId, 30_000);

  let state: RemotePostState;
  try {
    const { credentials } = await getValidCredentials(
      {
        prisma: container.prisma,
        keyring: container.keyring,
        platforms: container.platforms,
      },
      target.socialAccountId,
      ctx,
    );

    state = await adapter.publisher.fetchRemoteState(credentials, target.remoteOperationId, ctx);
  } catch (error) {
    // Token morreu no meio da janela de processamento: o desfecho remoto é
    // desconhecido e quem decide é uma pessoa, depois de reconectar a conta.
    if (error instanceof TokenExpiredError) {
      await failRemote(container, target, 'TOKEN_EXPIRED',
        'A credencial expirou enquanto a plataforma processava o envio e o resultado ' +
          'não pôde ser confirmado. Reconecte a conta e confira se a publicação saiu.',
        log, 'TOKEN_EXPIRED');
      return;
    }

    // Erro recuperável: devolve ao BullMQ, que re-tenta com backoff sem
    // encerrar o rastreamento (o prazo máximo continua valendo no banco).
    if (isRetryable(error)) {
      log.warn({ err: error, attempt: job.data.attempt }, 'consulta ao estado remoto falhou — nova tentativa');
      throw error;
    }

    await failRemote(container, target, 'REMOTE_STATE_CHECK_FAILED',
      'A consulta do estado remoto falhou de forma não recuperável e o resultado da ' +
        'publicação é desconhecido. Confira a conta antes de tentar novamente.',
      log);
    return;
  }

  if (state.status === 'PROCESSING') {
    const attempt = job.data.attempt + 1;
    const delay = pollDelayMs(container.env.REMOTE_STATE_FIRST_POLL_MS, attempt);

    // Reagenda O MESMO job: moveToDelayed não consome tentativa e o job fica
    // no Redis, então reiniciar o worker não interrompe o acompanhamento.
    await job.updateData({ ...job.data, attempt });
    await job.moveToDelayed(Date.now() + delay, job.token);

    log.debug({ attempt, delay, remoteOperationId: target.remoteOperationId },
      'plataforma ainda processando — nova consulta agendada');

    throw new DelayedError();
  }

  if (state.status === 'READY') {
    if (target.processingDeadlineAt && Date.now() > target.processingDeadlineAt.getTime()) {
      await markRemoteProcessingTimeout(container, target, log);
      return;
    }
    await confirmPublished(container, target, state, log);
    return;
  }

  if (state.status === 'REJECTED') {
    await failRemote(container, target, 'REMOTE_REJECTED',
      `A plataforma rejeitou a publicação depois de aceitar o envio: ${
        state.rejectionReason ?? 'motivo não informado'
      }`, log);
    return;
  }

  // DELETED: a plataforma removeu o conteúdo durante/após o processamento.
  await failRemote(container, target, 'REMOTE_DELETED',
    'A plataforma removeu a publicação durante o processamento.', log);
}

// ---------------------------------------------------------------------------
//  Varredura de segurança
// ---------------------------------------------------------------------------

/**
 * Rede de segurança para destinos PROCESSING cujo job de verificação se
 * perdeu (worker morto entre gravar PROCESSING e enfileirar, Redis
 * reiniciado, job removido por engano). Também é quem aplica o prazo máximo
 * quando a cadeia de consultas morreu por completo.
 *
 * O upload NUNCA é refeito aqui: perder o job de verificação não significa
 * perder o envio, que a plataforma já aceitou.
 */
export async function reconcileProcessingTargets(
  container: WorkerContainer,
  publishQueue: Queue,
): Promise<{ reenfileirados: number; expirados: number }> {
  const log = container.logger.child({ job: 'reconcile-processing' });
  const now = Date.now();

  const targets = await container.prisma.postTarget.findMany({
    where: { status: 'PROCESSING', deletedAt: null },
    select: targetSelect,
    take: 50,
  });

  const resultado = { reenfileirados: 0, expirados: 0 };

  for (const target of targets) {
    if (target.processingDeadlineAt && now > target.processingDeadlineAt.getTime()) {
      await markRemoteProcessingTimeout(container, target, log);
      resultado.expirados += 1;
      continue;
    }

    const jobId = target.jobId ?? checkRemoteJobId(target.id);
    const job = await publishQueue.getJob(jobId);

    const precisaReenfileirar =
      !job ||
      (await job.isCompleted()) ||
      // Falhou todas as tentativas de consulta (rede instável, por exemplo) e
      // ninguém reagendou: o destino não pode ficar sem acompanhamento.
      ((await job.isFailed()) && job.attemptsMade >= (job.opts.attempts ?? 1));

    if (!precisaReenfileirar) continue;

    if (job) await job.remove().catch(() => undefined);

    await publishQueue.add(
      JOB_CHECK_REMOTE_STATE,
      {
        postTargetId: target.id,
        organizationId: target.organizationId,
        attempt: 0,
        correlationId: `reconciled-${target.id}`,
      },
      {
        jobId: checkRemoteJobId(target.id),
        delay: 0,
        attempts: 10,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: true,
      },
    );

    await container.prisma.postTarget.update({
      where: { id: target.id },
      data: { jobId: checkRemoteJobId(target.id) },
    });

    resultado.reenfileirados += 1;
  }

  if (resultado.reenfileirados > 0 || resultado.expirados > 0) {
    log.warn(resultado, 'destinos em processamento remoto reconciliados');
  }

  return resultado;
}

// ---------------------------------------------------------------------------

async function confirmPublished(
  container: WorkerContainer,
  target: CheckTarget,
  state: RemotePostState,
  log: WorkerContainer['logger'],
): Promise<void> {
  await container.prisma.$transaction([
    container.prisma.postTarget.update({
      where: { id: target.id },
      data: {
        status: 'PUBLISHED',
        // O id PÚBLICO vem da consulta de estado — no TikTok, ele só existe
        // depois do PUBLISH_COMPLETE e não é o publish_id.
        remoteId: state.remoteId,
        remoteUrl: state.remoteUrl ?? null,
        publishedAt: new Date(),
        processingDeadlineAt: null,
        errorCode: null,
        errorMessage: null,
      },
    }),
    container.prisma.socialAccount.update({
      where: { id: target.socialAccountId },
      data: { lastPublishedAt: new Date() },
    }),
  ]);

  await recomputePostStatus(container.prisma, target.postId);

  log.info({ remoteId: state.remoteId }, 'processamento remoto confirmado — publicação no ar');

  await notify(container, {
    organizationId: target.organizationId,
    type: 'POST_PUBLISHED',
    title: `Publicado em ${target.socialAccount.nickname}`,
    body: state.remoteUrl
      ? `A publicação está no ar: ${state.remoteUrl}`
      : 'A plataforma confirmou a publicação depois de processar o envio.',
    actionUrl: `/fila?post=${target.postId}`,
    metadata: { postTargetId: target.id, remoteId: state.remoteId },
  });
}

async function failRemote(
  container: WorkerContainer,
  target: CheckTarget,
  code: string,
  message: string,
  log: WorkerContainer['logger'],
  notificationType: string = 'POST_FAILED',
): Promise<void> {
  await container.prisma.postTarget.update({
    where: { id: target.id },
    data: {
      status: 'FAILED',
      errorCode: code,
      errorMessage: message,
      // A plataforma deliberadamente recusou/encerrou o envio: re-tentar o
      // MESMO conteúdo não muda a decisão.
      errorPermanent: true,
      processingDeadlineAt: null,
      nextRetryAt: null,
    },
  });

  await recomputePostStatus(container.prisma, target.postId);

  log.warn({ code }, 'verificação remota encerrou o destino');

  await notify(container, {
    organizationId: target.organizationId,
    type: notificationType,
    title: `Falha ao publicar em ${target.socialAccount.nickname}`,
    body: `${message} Os outros destinos desta publicação não foram afetados.`,
    actionUrl: `/fila?post=${target.postId}`,
    metadata: { postTargetId: target.id, code },
  });
}

async function markRemoteProcessingTimeout(
  container: WorkerContainer,
  target: CheckTarget,
  log: WorkerContainer['logger'],
): Promise<void> {
  await container.prisma.postTarget.update({
    where: { id: target.id },
    data: {
      status: 'FAILED',
      errorCode: 'REMOTE_PROCESSING_TIMEOUT',
      errorMessage:
        'A plataforma não confirmou o processamento dentro do prazo máximo. O resultado ' +
        'remoto é desconhecido: confira a conta antes de tentar novamente, porque reenviar ' +
        'às cegas poderia publicar o mesmo conteúdo duas vezes.',
      errorPermanent: true,
      processingDeadlineAt: null,
      nextRetryAt: null,
    },
  });

  await recomputePostStatus(container.prisma, target.postId);

  log.error({ postTargetId: target.id }, 'prazo de processamento remoto esgotado — desfecho desconhecido');

  await notify(container, {
    organizationId: target.organizationId,
    type: 'POST_FAILED',
    title: `Resultado desconhecido em ${target.socialAccount.nickname}`,
    body:
      'A plataforma não confirmou o envio dentro do prazo. Confira a conta: se a publicação ' +
      'não saiu, use "tentar novamente" sabendo que havia um envio em andamento.',
    actionUrl: `/fila?post=${target.postId}`,
    metadata: { postTargetId: target.id, code: 'REMOTE_PROCESSING_TIMEOUT' },
  });
}
