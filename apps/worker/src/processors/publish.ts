import {
  CircuitOpenError,
  DEFAULT_BACKOFF,
  QuotaExceededError,
  TokenExpiredError,
  checkRemoteJobId,
  isRetryable,
  nextRetryDelay,
  resolveVariantFor,
  type AdapterContext,
  type CheckRemoteStatePayload,
  type PublishInput,
  type PublishTargetPayload,
} from '@app/core';
import { getValidCredentials, nextQuotaResetAt, releaseQuota, reserveQuota } from '@app/platform';
import { DelayedError, type Job } from 'bullmq';
import { Prisma } from '@app/db';
import { PassThrough } from 'node:stream';
import type { WorkerContainer } from '../container.js';
import { adapterContext } from '../lib/adapter-context.js';
import { recordDeadLetter } from '../lib/dead-letter.js';
import { notify } from '../lib/notifications.js';
import { recomputePostStatus } from '../lib/post-status.js';


/**
 * Publicação de UM destino.
 *
 * Este processador é a única coisa no sistema que faz um post existir numa
 * rede social, então as garantias dele são o produto:
 *
 *  1. IDEMPOTÊNCIA. Antes de qualquer chamada externa, o destino é movido
 *     para PUBLISHING com um UPDATE condicional. Se outro worker já pegou o
 *     mesmo job, o update não afeta nenhuma linha e este sai sem publicar.
 *     Um destino que já tem `remoteId` também sai na hora.
 *  2. ISOLAMENTO. O job é por destino. Nada aqui conhece os outros 19 da
 *     mesma publicação: falhar não os afeta, e a transação nunca os abrange.
 *  3. CLASSIFICAÇÃO DE ERRO. Erro permanente (título inválido, token
 *     revogado) marca FALHOU na hora. Erro recuperável reagenda com backoff.
 *     Cota estourada REAGENDA para depois do reset em vez de gastar tentativa.
 */

/**
 * O  fica aqui em cima para o tipo do destino carregado ser DERIVADO
 * da própria consulta. Repetir a forma à mão faria os dois divergirem em
 * silêncio na primeira mudança de schema.
 */
const targetInclude = {
  socialAccount: {
    select: {
      id: true,
      nickname: true,
      platform: true,
      timezone: true,
      status: true,
      organizationId: true,
      // Id da conta NA PLATAFORMA (channel id, page id, ig user id).
      // É com ele que o adapter monta o caminho da chamada.
      remoteId: true,
    },
  },
  post: {
    include: {
      content: {
        include: {
          variants: true,
          media: { include: { mediaAsset: true }, orderBy: { position: 'asc' } },
        },
      },
    },
  },
} satisfies Prisma.PostTargetInclude;

type LoadedTarget = Prisma.PostTargetGetPayload<{ include: typeof targetInclude }>;

/**
 * Agenda a verificação do estado remoto. Injetada pelo `main` (que é dono da
 * fila) para o processador não depender de BullMQ diretamente. Nos testes,
 * basta um gravador de chamadas.
 *
 * A ausência dela NÃO perde a verificação: o varredor
 * `reconcileProcessingTargets` recoloca na fila qualquer destino PROCESSING
 * cujo job tenha se perdido.
 */
export type ScheduleRemoteStateCheck = (
  payload: CheckRemoteStatePayload,
  delayMs: number,
) => Promise<void>;

/** Desfecho do envio: confirmado na hora ou aceito para processamento remoto. */
export type PublishOutcome = 'PUBLISHED' | 'PROCESSING';

export async function processPublishTarget(
  container: WorkerContainer,
  job: Job<PublishTargetPayload>,
  scheduleRemoteStateCheck?: ScheduleRemoteStateCheck,
): Promise<void> {
  const { postTargetId, correlationId } = job.data;
  const log = container.logger.child({ correlationId, postTargetId, jobId: job.id });

  const target = await container.prisma.postTarget.findUnique({
    where: { id: postTargetId },
    include: targetInclude,
  });

  if (!target || target.deletedAt) {
    log.warn('destino inexistente ou removido — nada a publicar');
    return;
  }

  // --- Portas de idempotência ---------------------------------------------

  if (target.remoteId) {
    log.info({ remoteId: target.remoteId }, 'destino já publicado — job ignorado');
    return;
  }

  if (target.status === 'CANCELLED') {
    log.info('destino cancelado — job ignorado');
    return;
  }

  /**
   * UPDATE condicional: só avança quem encontrar o destino ainda pendente.
   * É esta linha que impede dois workers de publicarem o mesmo destino — a
   * decisão é do banco, não de uma leitura anterior.
   */
  const claimed = await container.prisma.postTarget.updateMany({
    where: {
      id: postTargetId,
      status: { in: ['SCHEDULED', 'QUEUED'] },
      remoteId: null,
    },
    data: {
      status: 'PUBLISHING',
      attempts: { increment: 1 },
      lastAttemptAt: new Date(),
      correlationId,
    },
  });

  if (claimed.count === 0) {
    log.info(
      { status: target.status },
      'outro processo já assumiu este destino — job ignorado',
    );
    return;
  }

  const attemptNumber = target.attempts + 1;
  const attempt = await container.prisma.publishAttempt.create({
    data: {
      postTargetId,
      organizationId: target.organizationId,
      attemptNumber,
      correlationId,
    },
  });

  const startedAt = Date.now();
  const ctx = adapterContext(container, correlationId, 120_000);

  try {
    const outcome = await publishNow(container, target, ctx, log, attempt.id);

    await container.prisma.publishAttempt.update({
      where: { id: attempt.id },
      data: {
        success: true,
        finishedAt: new Date(),
        durationMs: Date.now() - startedAt,
      },
    });

    await container.circuit.onSuccess(target.platform);

    if (outcome === 'PROCESSING') {
      /**
       * A plataforma aceitou o envio mas ainda processa (transcodificação).
       * O destino ficou PROCESSING: quem confirma é o job de verificação,
       * reagendado até a confirmação ou o prazo máximo. Se esta enfileiração
       * falhar ou o worker cair antes dela, o varredor de destinos
       * PROCESSING recoloca o job — o upload NUNCA é refeito.
       */
      await container.prisma.postTarget.update({
        where: { id: target.id },
        data: { jobId: checkRemoteJobId(postTargetId) },
      });

      if (scheduleRemoteStateCheck) {
        await scheduleRemoteStateCheck(
          {
            postTargetId,
            organizationId: target.organizationId,
            attempt: 0,
            correlationId,
          },
          container.env.REMOTE_STATE_FIRST_POLL_MS,
        );
      } else {
        log.warn('sem enfileirador de verificação — o varredor recolocará o job');
      }
    }
  } catch (error) {
    const ultimaTentativa = await container.prisma.publishAttempt.update({
      where: { id: attempt.id },
      data: {
        success: false,
        finishedAt: new Date(),
        durationMs: Date.now() - startedAt,
        errorCode: errorCodeOf(error),
        errorMessage: messageOf(error).slice(0, 2000),
      },
    });

    await handleFailure(
      container,
      target,
      error,
      attemptNumber,
      job,
      log,
      // A chamada à plataforma chegou a sair? É o que decide se a cota pode
      // ser devolvida quando a falha vira definitiva: depois do envio, o
      // consumo remoto pode já ter acontecido — um timeout NÃO devolve cota.
      ultimaTentativa.externalCallStartedAt !== null,
    );
  } finally {
    await recomputePostStatus(container.prisma, target.postId);
  }
}

// ---------------------------------------------------------------------------



async function publishNow(
  container: WorkerContainer,
  target: LoadedTarget,
  ctx: AdapterContext,
  log: WorkerContainer['logger'],
  attemptId: string,
): Promise<PublishOutcome> {
  const post = target.post;
  if (!post) throw new Error('Publicação não encontrada para este destino.');

  const content = post.content;
  const remoteAccountId = target.socialAccount.remoteId;

  // Conteúdo gerado por IA exige revisão humana antes de publicar
  // (SPEC seção 6). O worker é a última barreira.
  if (content.aiGenerated && content.aiReviewedAt === null) {
    throw Object.assign(
      new Error(
        'Este conteúdo foi gerado por IA e ainda não passou por revisão humana. ' +
          'Revise antes de publicar.',
      ),
      { permanent: true, code: 'AI_REVIEW_REQUIRED' },
    );
  }

  // Circuito da plataforma: se está aberto, nem tentamos.
  await container.circuit.assertClosed(target.platform);

  // Cota reservada ANTES da chamada externa. Se estourou, o erro carrega
  // quando a janela reseta, e o tratamento reagenda em vez de re-tentar.
  await reserveQuota(container.prisma, {
    platform: target.platform,
    socialAccountId: target.socialAccountId,
    organizationId: target.organizationId,
    at: new Date(),
  });

  const { credentials } = await getValidCredentials(
    {
      prisma: container.prisma,
      keyring: container.keyring,
      platforms: container.platforms,
    },
    target.socialAccountId,
    ctx,
  );

  // A mesma cascata que o preview usou: override da conta > variação da
  // rede > conteúdo mestre. Se divergisse, o publicado não seria o revisado.
  const variant = resolveVariantFor(
    { title: content.title, body: content.body, hashtags: content.hashtags },
    content.variants,
    target.platform,
    target.socialAccountId,
  );

  /**
   * Algumas plataformas RECEBEM os bytes (YouTube, TikTok); outras BUSCAM a
   * mídia numa URL pública (Meta). Fornecemos os dois, e cada adapter usa o
   * que a sua API exige.
   *
   * A URL vale 1 hora: a Meta leva minutos para buscar e transcodificar, e
   * uma URL que expira no meio faz o contêiner falhar sem motivo aparente.
   */
  const midias = await Promise.all(
    content.media.map(async (link) => ({
      link,
      publicUrl: await container.storage
        .getSignedDownloadUrl(link.mediaAsset.storageKey, 3600)
        .catch(() => undefined),
    })),
  );

  const input: PublishInput = {
    idempotencyKey: target.idempotencyKey,
    body: variant.body,
    hashtags: variant.hashtags,
    platformFields: {
      ...variant.platformFields,
      // O id da conta NA PLATAFORMA (canal, Página, conta do Instagram).
      // O adapter precisa dele para montar o caminho da chamada, e ele não
      // pertence ao conteúdo — vem da conta conectada.
      __remoteAccountId: remoteAccountId,
    },
    media: midias.map(({ link, publicUrl }) => ({
      // Stream sob demanda: um vídeo de 2 GB não pode ser carregado em
      // memória, e o adapter pode precisar reabrir o stream para retomar.
      // O contrato do adapter é síncrono, mas abrir o objeto no storage é
      // assíncrono: o PassThrough faz a ponte e ainda permite ao adapter
      // reabrir o stream do zero para retomar um upload interrompido.
      stream: () => {
        const passthrough = new PassThrough();

        void container.storage
          .getObjectStream(link.mediaAsset.storageKey)
          .then((source) => {
            source.on('error', (error) => passthrough.destroy(error));
            source.pipe(passthrough);
          })
          .catch((error: unknown) => passthrough.destroy(error as Error));

        return passthrough;
      },
      mimeType: link.mediaAsset.mimeType,
      sizeBytes: Number(link.mediaAsset.sizeBytes),
      filename: link.mediaAsset.originalFilename,
      ...(publicUrl ? { publicUrl } : {}),
      ...(link.mediaAsset.durationMs !== null ? { durationMs: link.mediaAsset.durationMs } : {}),
      ...(link.mediaAsset.width !== null ? { width: link.mediaAsset.width } : {}),
      ...(link.mediaAsset.height !== null ? { height: link.mediaAsset.height } : {}),
    })),
    ...(variant.title ? { title: variant.title } : {}),
  };

  const adapter = container.platforms.adapters.get(target.platform);

  log.info(
    { platform: target.platform, conta: target.socialAccount.nickname },
    'publicando na plataforma',
  );

  /**
   * Marca o instante em que a chamada externa é disparada, ANTES de disparar.
   *
   * É o que permite recuperar um destino travado sem arriscar publicação
   * duplicada: se o worker morrer e este campo estiver nulo, o processo caiu
   * antes de falar com a plataforma e o destino pode voltar para a fila com
   * segurança. Preenchido e sem `finishedAt`, não há como saber se saiu — e aí
   * a recuperação não re-tenta. Gravar DEPOIS da chamada inverteria a
   * garantia e tornaria o campo inútil.
   */
  await container.prisma.publishAttempt.update({
    where: { id: attemptId },
    data: { externalCallStartedAt: new Date() },
  });

  const result = await adapter.publisher.publish(credentials, input, ctx);

  /**
   * Envio aceito NÃO é publicação concluída. TikTok, YouTube e Facebook
   * processam o vídeo de forma assíncrona e podem rejeitar DEPOIS de aceitar.
   * `processingPending` marca exatamente esse caso: o destino vai para
   * PROCESSING com o identificador da OPERAÇÃO (que pode não ser o id público
   * do post — no TikTok o publish_id não é), sem notificação de sucesso e sem
   * `remoteId`, até a confirmação do job de verificação.
   */
  if (result.processingPending) {
    await container.prisma.postTarget.update({
      where: { id: target.id },
      data: {
        status: 'PROCESSING',
        remoteOperationId: result.remoteId,
        processingDeadlineAt: new Date(Date.now() + container.env.REMOTE_STATE_MAX_WINDOW_MS),
        errorCode: null,
        errorMessage: null,
      },
    });

    log.info(
      { remoteOperationId: result.remoteId },
      'envio aceito pela plataforma — aguardando confirmação do processamento remoto',
    );

    return 'PROCESSING';
  }

  await container.prisma.$transaction([
    container.prisma.postTarget.update({
      where: { id: target.id },
      data: {
        status: 'PUBLISHED',
        remoteId: result.remoteId,
        remoteUrl: result.remoteUrl ?? null,
        publishedAt: new Date(),
        errorCode: null,
        errorMessage: null,
      },
    }),
    container.prisma.socialAccount.update({
      where: { id: target.socialAccountId },
      data: { lastPublishedAt: new Date() },
    }),
  ]);

  log.info(
    { remoteId: result.remoteId, remoteUrl: result.remoteUrl },
    'publicado com sucesso',
  );

  await notify(container, {
    organizationId: target.organizationId,
    type: 'POST_PUBLISHED',
    title: `Publicado em ${target.socialAccount.nickname}`,
    body: result.remoteUrl
      ? `A publicação está no ar: ${result.remoteUrl}`
      : 'A publicação foi aceita pela plataforma.',
    actionUrl: `/fila?post=${target.postId}`,
    metadata: { postTargetId: target.id, remoteId: result.remoteId },
  });

  return 'PUBLISHED';
}

// ---------------------------------------------------------------------------

async function handleFailure(
  container: WorkerContainer,
  target: LoadedTarget,
  error: unknown,
  attemptNumber: number,
  job: Job<PublishTargetPayload>,
  log: WorkerContainer['logger'],
  externalCallStarted: boolean,
): Promise<void> {
  const code = errorCodeOf(error);
  const message = messageOf(error);

  // --- Cota estourada: REAGENDA, não gasta tentativa ----------------------
  if (error instanceof QuotaExceededError) {
    const resetsAt = error.resetsAt ?? nextQuotaResetAt(target.platform, new Date());

    await container.prisma.postTarget.update({
      where: { id: target.id },
      data: {
        status: 'SCHEDULED',
        scheduledAt: resetsAt,
        // A tentativa não conta: não houve falha de publicação, houve
        // decisão nossa de não tentar ainda.
        attempts: Math.max(0, attemptNumber - 1),
        errorCode: code,
        errorMessage: message,
        nextRetryAt: resetsAt,
      },
    });

    /**
     * `job.changeDelay` só vale para job no estado DELAYED — num job ATIVO
     * (este, em processamento) o BullMQ lança JobNotInState e a fila
     * re-tentaria pelo backoff de erro, no horário errado e gastando
     * tentativa. O mecanismo correto do BullMQ 5 é mover o próprio job para
     * delayed (com o token do lock, sem consumir tentativa) e encerrar o
     * processamento com DelayedError.
     */
    await job.moveToDelayed(Math.max(Date.now() + 1000, resetsAt.getTime()), job.token);

    log.warn({ resetsAt }, 'cota atingida — destino reagendado para depois do reset');

    await notify(container, {
      organizationId: target.organizationId,
      type: 'QUOTA_EXCEEDED',
      title: `Cota atingida em ${target.socialAccount.nickname}`,
      body: `${message} A publicação foi reagendada automaticamente.`,
      actionUrl: `/fila?post=${target.postId}`,
    });
    throw new DelayedError();
  }

  // --- Circuito aberto: espera a janela, sem gastar tentativa -------------
  if (error instanceof CircuitOpenError) {
    const retryAt = new Date(Date.now() + error.retryAfterMs);

    await container.prisma.postTarget.update({
      where: { id: target.id },
      data: {
        status: 'SCHEDULED',
        scheduledAt: retryAt,
        attempts: Math.max(0, attemptNumber - 1),
        errorCode: code,
        errorMessage: message,
        nextRetryAt: retryAt,
      },
    });

    await job.moveToDelayed(retryAt.getTime(), job.token);
    log.warn({ retryAt }, 'circuito aberto — destino aguardando a plataforma voltar');
    throw new DelayedError();
  }

  await container.circuit.onFailure(target.platform);

  const permanent =
    !isRetryable(error) ||
    (error as { permanent?: boolean }).permanent === true ||
    error instanceof TokenExpiredError;

  const attemptsLeft = target.maxAttempts - attemptNumber;

  // --- Recuperável e com tentativa sobrando: backoff ---------------------
  if (!permanent && attemptsLeft > 0) {
    const delay = nextRetryDelay(error, attemptNumber, DEFAULT_BACKOFF) ?? 60_000;
    const retryAt = new Date(Date.now() + delay);

    await container.prisma.postTarget.update({
      where: { id: target.id },
      data: {
        status: 'SCHEDULED',
        nextRetryAt: retryAt,
        errorCode: code,
        errorMessage: message,
        errorPermanent: false,
      },
    });

    log.warn(
      { tentativa: attemptNumber, de: target.maxAttempts, retryAt, code },
      'falha recuperável — nova tentativa agendada',
    );

    // Relança para o BullMQ contabilizar a tentativa e reprogramar o job.
    throw error;
  }

  // --- Falha definitiva --------------------------------------------------
  await container.prisma.postTarget.update({
    where: { id: target.id },
    data: {
      status: 'FAILED',
      errorCode: code,
      errorMessage: message,
      errorPermanent: permanent,
      nextRetryAt: null,
    },
  });

  // Devolve a cota reservada APENAS quando a falha não pôde ter consumido a
  // janela remota: a chamada nunca saiu (validação, circuito, cota), ou a
  // plataforma recusou na AUTENTICAÇÃO (401 sem aceitar nada do upload).
  //
  // Timeout/5xx DEPOIS do envio é o caso traiçoeiro: o upload pode ter sido
  // contado plataforma adentro, e devolver a reserva "porque falhou"
  // estouraria o limite real do dia (ex.: 100 uploads/dia do YouTube) quando
  // a publicação for refeita.
  if (externalCallStarted && !(error instanceof TokenExpiredError)) {
    log.warn(
      { code },
      'falha DEPOIS do envio à plataforma — cota mantida, pois o consumo remoto já pode existir',
    );
  } else {
    await releaseQuota(container.prisma, {
      platform: target.platform,
      socialAccountId: target.socialAccountId,
      at: new Date(),
    });
  }

  // Dead-letter: jobs que esgotaram o retry ficam visíveis no painel admin,
  // nunca somem silenciosamente (SPEC seção 12).
  await recordDeadLetter(container, {
    queueName: 'publish',
    jobName: job.name,
    jobId: job.id ?? null,
    organizationId: target.organizationId,
    payload: job.data as unknown as Record<string, unknown>,
    attemptsMade: attemptNumber,
    failedReason: message,
    correlationId: job.data.correlationId,
  });

  log.error({ code, permanent, tentativas: attemptNumber }, 'destino falhou definitivamente');

  await notify(container, {
    organizationId: target.organizationId,
    type: error instanceof TokenExpiredError ? 'TOKEN_EXPIRED' : 'POST_FAILED',
    title: `Falha ao publicar em ${target.socialAccount.nickname}`,
    body:
      message +
      ' Os outros destinos desta publicação não foram afetados.',
    actionUrl: `/fila?post=${target.postId}`,
    metadata: { postTargetId: target.id, code },
  });
}

function errorCodeOf(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    return String((error as { code: unknown }).code);
  }
  return 'UNKNOWN_ERROR';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
