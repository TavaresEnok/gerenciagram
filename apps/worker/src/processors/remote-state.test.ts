import { checkRemoteJobId, getPlatformDefinition, type RemotePostState } from '@app/core';
import { quotaWindowFor } from '@app/platform';
import { DelayedError } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createHarness,
  createScenario,
  fakeCheckJob,
  fakeJob,
  type TestHarness,
} from '../test/harness.js';
import { processPublishTarget } from './publish.js';
import { processCheckRemoteState, reconcileProcessingTargets } from './remote-state.js';

/**
 * O defeito corrigido: o marcador como PUBLISHED acontecia no "envio aceito",
 * enquanto TikTok, YouTube e Facebook processam o vídeo de forma assíncrona e
 * podem rejeitar DEPOIS — a interface anunciava uma publicação que a rede
 * ainda podia derrubar.
 *
 * O que estes testes provam, contra Postgres real:
 *
 *  - aceito ≠ publicado: processingPending leva a PROCESSING, sem remoteId e
 *    sem notificação de sucesso;
 *  - PROCESSING → READY confirma, guarda o id PÚBLICO e só então notifica;
 *  - PROCESSING → REJECTED falha com o motivo, SEM devolver a cota (o upload
 *    já consumiu a janela remota);
 *  - prazo máximo esgotado falha como desconhecido, pedindo conferência;
 *  - consulta repetida/tardia não duplica notificação nem regrava estado;
 *  - job perdido (worker reiniciado) é recolocado pelo varredor, sem refazer
 *    o upload.
 */

let harness: TestHarness;

/** Gravador da enfileiração da verificação, no lugar do BullMQ. */
function enfileiradorFalso() {
  const enfileirados: Array<{ postTargetId: string; attempt: number; delayMs: number }> = [];

  return {
    enfileirados,
    agendar: async (
      payload: { postTargetId: string; attempt: number },
      delayMs: number,
    ): Promise<void> => {
      enfileirados.push({ postTargetId: payload.postTargetId, attempt: payload.attempt, delayMs });
    },
  };
}

async function deixarEmProcessing(
  postTargetId: string,
  options?: { prazoEsgotado?: boolean; semOperacao?: boolean; jobId?: string | null },
): Promise<void> {
  await harness.prisma.postTarget.update({
    where: { id: postTargetId },
    data: {
      status: 'PROCESSING',
      remoteOperationId: options?.semOperacao ? null : 'publish-id-123',
      processingDeadlineAt: options?.prazoEsgotado
        ? new Date(Date.now() - 60_000)
        : new Date(Date.now() + 60 * 60_000),
      jobId: options?.jobId === undefined ? checkRemoteJobId(postTargetId) : options.jobId,
    },
  });
}

beforeEach(async () => {
  harness = await createHarness('YOUTUBE');
});

afterEach(async () => {
  await harness.cleanup();
});

describe('o envio aceito NÃO é publicação concluída', () => {
  it('processingPending leva a PROCESSING, sem remoteId e sem notificação de sucesso', async () => {
    const cenario = await createScenario(harness.prisma, { accountCount: 1 });
    const alvo = cenario.targets[0]!;
    const { enfileirados, agendar } = enfileiradorFalso();

    harness.behavior.responses.push({
      remoteId: 'video-abc',
      remoteUrl: 'https://www.youtube.com/watch?v=video-abc',
      processingPending: true,
    });

    await processPublishTarget(
      harness.container,
      fakeJob(alvo.id, cenario.organizationId),
      agendar,
    );

    const destino = await harness.prisma.postTarget.findUniqueOrThrow({
      where: { id: alvo.id },
    });

    expect(destino.status).toBe('PROCESSING');
    // A operação remota é guardada; o id PÚBLICO só após a confirmação.
    expect(destino.remoteOperationId).toBe('video-abc');
    expect(destino.remoteId).toBeNull();
    expect(destino.publishedAt).toBeNull();
    expect(destino.processingDeadlineAt).not.toBeNull();
    expect(destino.jobId).toBe(checkRemoteJobId(alvo.id));

    // A verificação foi agendada, com a primeira consulta no futuro.
    expect(enfileirados).toHaveLength(1);
    expect(enfileirados[0]).toMatchObject({ postTargetId: alvo.id, attempt: 0, delayMs: 30_000 });

    // NENHUMA notificação de publicação concluída durante o processamento.
    const avisos = await harness.prisma.notification.findMany({
      where: { organizationId: cenario.organizationId },
    });
    expect(avisos.filter((aviso) => aviso.type === 'POST_PUBLISHED')).toHaveLength(0);

    // O agregado do post continua "em publicação", não "publicado".
    const post = await harness.prisma.post.findUniqueOrThrow({ where: { id: cenario.postId } });
    expect(post.status).toBe('PUBLISHING');

    // Atenção à cota: o upload já aconteceu remotamente, então ela FICA.
    const cota = await harness.prisma.platformQuotaUsage.findFirstOrThrow({
      where: { platform: 'YOUTUBE', scopeKey: 'APP' },
    });
    expect(cota.count).toBe(1);
  });

  it('sem processingPending, o comportamento de antes é preservado', async () => {
    const cenario = await createScenario(harness.prisma, { accountCount: 1 });
    const alvo = cenario.targets[0]!;
    const { enfileirados, agendar } = enfileiradorFalso();

    harness.behavior.responses.push({ remoteId: 'video-abc', processingPending: false });

    await processPublishTarget(
      harness.container,
      fakeJob(alvo.id, cenario.organizationId),
      agendar,
    );

    const destino = await harness.prisma.postTarget.findUniqueOrThrow({
      where: { id: alvo.id },
    });
    expect(destino.status).toBe('PUBLISHED');
    expect(destino.remoteId).toBe('video-abc');
    expect(enfileirados).toHaveLength(0);
  });
});

describe('verificação do estado remoto', () => {
  it('PROCESSING → READY confirma a publicação e só então notifica', async () => {
    const cenario = await createScenario(harness.prisma, { accountCount: 1 });
    const alvo = cenario.targets[0]!;
    await deixarEmProcessing(alvo.id);

    harness.behavior.remoteStates.push({
      remoteId: 'video-publico',
      status: 'READY',
      remoteUrl: 'https://www.youtube.com/watch?v=video-publico',
    } satisfies RemotePostState);

    const { job } = fakeCheckJob(alvo.id, cenario.organizationId);
    await processCheckRemoteState(harness.container, job);

    expect(harness.behavior.stateCalls).toEqual(['publish-id-123']);

    const destino = await harness.prisma.postTarget.findUniqueOrThrow({
      where: { id: alvo.id },
    });
    expect(destino.status).toBe('PUBLISHED');
    expect(destino.remoteId).toBe('video-publico');
    expect(destino.remoteUrl).toContain('video-publico');
    expect(destino.publishedAt).toBeInstanceOf(Date);
    expect(destino.processingDeadlineAt).toBeNull();

    const avisos = await harness.prisma.notification.findMany({
      where: { organizationId: cenario.organizationId, type: 'POST_PUBLISHED' },
    });
    expect(avisos).toHaveLength(1);

    const post = await harness.prisma.post.findUniqueOrThrow({ where: { id: cenario.postId } });
    expect(post.status).toBe('PUBLISHED');
  });

  it('PROCESSING → REJECTED falha com o motivo e NÃO devolve a cota', async () => {
    const cenario = await createScenario(harness.prisma, { accountCount: 1 });
    const alvo = cenario.targets[0]!;
    await deixarEmProcessing(alvo.id);

    // Simula a cota já consumida pelo upload aceito.
    await harness.prisma.platformQuotaUsage.upsert({
      where: {
        platform_scopeKey_windowDate: {
          platform: 'YOUTUBE',
          scopeKey: 'APP',
          windowDate: maiorJanelaPossivel(),
        },
      },
      create: {
        platform: 'YOUTUBE',
        scopeKey: 'APP',
        windowDate: maiorJanelaPossivel(),
        windowStart: new Date(Date.now() - 3_600_000),
        windowEnd: new Date(Date.now() + 3_600_000),
        count: 5,
        units: 5,
      },
      update: { count: 5 },
    });

    harness.behavior.remoteStates.push({
      remoteId: 'publish-id-123',
      status: 'REJECTED',
      rejectionReason: 'Violação das diretrizes de conteúdo',
    } satisfies RemotePostState);

    const { job } = fakeCheckJob(alvo.id, cenario.organizationId);
    await processCheckRemoteState(harness.container, job);

    const destino = await harness.prisma.postTarget.findUniqueOrThrow({
      where: { id: alvo.id },
    });
    expect(destino.status).toBe('FAILED');
    expect(destino.errorCode).toBe('REMOTE_REJECTED');
    expect(destino.errorMessage).toContain('Violação das diretrizes');
    expect(destino.errorPermanent).toBe(true);

    // O upload já consumiu a janela remota: devolver a cota fingiria que a
    // publicação não aconteceu — e estouraria o limite real da plataforma.
    const cota = await harness.prisma.platformQuotaUsage.findFirstOrThrow({
      where: { platform: 'YOUTUBE', scopeKey: 'APP' },
    });
    expect(cota.count).toBe(5);

    const avisos = await harness.prisma.notification.findMany({
      where: { organizationId: cenario.organizationId, type: 'POST_FAILED' },
    });
    expect(avisos).toHaveLength(1);
    expect(avisos[0]?.title).toContain('Falha ao publicar');
  });

  it('ainda PROCESSING: reagenda o MESMO job com backoff, sem consumir tentativa', async () => {
    const cenario = await createScenario(harness.prisma, { accountCount: 1 });
    const alvo = cenario.targets[0]!;
    await deixarEmProcessing(alvo.id);

    harness.behavior.remoteStates.push({
      remoteId: 'publish-id-123',
      status: 'PROCESSING',
    } satisfies RemotePostState);

    const { job, reagendamentos, tentativas } = fakeCheckJob(alvo.id, cenario.organizationId);

    await expect(processCheckRemoteState(harness.container, job)).rejects.toBeInstanceOf(
      DelayedError,
    );

    // updateData avançou o attempt e moveToDelayed usou o token do lock.
    expect(tentativas).toEqual([1]);
    expect(reagendamentos).toHaveLength(1);
    expect(reagendamentos[0]!).toBeGreaterThan(Date.now());

    const destino = await harness.prisma.postTarget.findUniqueOrThrow({
      where: { id: alvo.id },
    });
    expect(destino.status).toBe('PROCESSING');
  });

  it('prazo máximo esgotado: falha como DESCONHECIDO, pedindo conferência', async () => {
    const cenario = await createScenario(harness.prisma, { accountCount: 1 });
    const alvo = cenario.targets[0]!;
    await deixarEmProcessing(alvo.id, { prazoEsgotado: true });

    // Nem chega a consultar a plataforma.
    const { job } = fakeCheckJob(alvo.id, cenario.organizationId);
    await processCheckRemoteState(harness.container, job);

    expect(harness.behavior.stateCalls).toHaveLength(0);

    const destino = await harness.prisma.postTarget.findUniqueOrThrow({
      where: { id: alvo.id },
    });
    expect(destino.status).toBe('FAILED');
    expect(destino.errorCode).toBe('REMOTE_PROCESSING_TIMEOUT');
    expect(destino.errorMessage).toMatch(/desconhecido/i);

    const avisos = await harness.prisma.notification.findMany({
      where: { organizationId: cenario.organizationId, type: 'POST_FAILED' },
    });
    expect(avisos).toHaveLength(1);
    expect(avisos[0]?.title).toMatch(/desconhecido/i);
  });

  it('consulta repetida/tardia depois da confirmação NÃO notifica de novo', async () => {
    const cenario = await createScenario(harness.prisma, { accountCount: 1 });
    const alvo = cenario.targets[0]!;

    // O destino já foi confirmado por um evento anterior (ou o worker
    // reiniciou depois de gravar e o job foi reentregue).
    await harness.prisma.postTarget.update({
      where: { id: alvo.id },
      data: { status: 'PUBLISHED', remoteId: 'video-publico', publishedAt: new Date() },
    });

    const { job } = fakeCheckJob(alvo.id, cenario.organizationId);
    await processCheckRemoteState(harness.container, job);

    expect(harness.behavior.stateCalls).toHaveLength(0);

    const avisos = await harness.prisma.notification.findMany({
      where: { organizationId: cenario.organizationId },
    });
    expect(avisos).toHaveLength(0);

    const destino = await harness.prisma.postTarget.findUniqueOrThrow({
      where: { id: alvo.id },
    });
    expect(destino.status).toBe('PUBLISHED');
    expect(destino.remoteId).toBe('video-publico');
  });
});

describe('reinício do worker / job de verificação perdido', () => {
  it('destino PROCESSING sem job é recolocado na fila, sem refazer o upload', async () => {
    const cenario = await createScenario(harness.prisma, { accountCount: 1 });
    const alvo = cenario.targets[0]!;

    // O worker morreu entre gravar PROCESSING e enfileirar a verificação.
    await deixarEmProcessing(alvo.id, { jobId: null });

    const enfileirados: string[] = [];
    const fila = {
      getJob: async () => null,
      add: async (_nome: string, dados: { postTargetId: string }) => {
        enfileirados.push(dados.postTargetId);
      },
      remove: async () => undefined,
    };

    const resultado = await reconcileProcessingTargets(harness.container, fila as never);

    expect(resultado).toEqual({ reenfileirados: 1, expirados: 0 });
    expect(enfileirados).toEqual([alvo.id]);
    // Nenhuma nova chamada de publicação: o upload não é refeito.
    expect(harness.behavior.calls).toHaveLength(0);

    const destino = await harness.prisma.postTarget.findUniqueOrThrow({
      where: { id: alvo.id },
    });
    expect(destino.jobId).toBe(checkRemoteJobId(alvo.id));
    expect(destino.status).toBe('PROCESSING');
  });

  it('destino PROCESSING com prazo esgotado vira REMOTE_PROCESSING_TIMEOUT sem consulta', async () => {
    const cenario = await createScenario(harness.prisma, { accountCount: 1 });
    const alvo = cenario.targets[0]!;
    await deixarEmProcessing(alvo.id, { prazoEsgotado: true });

    const fila = { getJob: async () => null, add: async () => undefined, remove: async () => undefined };
    const resultado = await reconcileProcessingTargets(harness.container, fila as never);

    expect(resultado).toEqual({ reenfileirados: 0, expirados: 1 });

    const destino = await harness.prisma.postTarget.findUniqueOrThrow({
      where: { id: alvo.id },
    });
    expect(destino.status).toBe('FAILED');
    expect(destino.errorCode).toBe('REMOTE_PROCESSING_TIMEOUT');
  });
});

/** windowDate da regra de cota do YouTube no instante atual, derivada da regra oficial. */
function maiorJanelaPossivel(): Date {
  // Evita hardcode: a janela vem da mesma função que reserveQuota usa — o
  // teste de baseline quebrava por fixar a meia-noite UTC, que nem sempre é
  // o início da janela da plataforma (YouTube: meia-noite no Pacífico).
  const regra = getPlatformDefinition('YOUTUBE').quotaRules.rules[0]!;
  return quotaWindowFor(regra, new Date()).windowDate;
}
