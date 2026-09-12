import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recoverStuckPublishing } from './maintenance.js';
import { createHarness, createScenario, type TestHarness } from '../test/harness.js';

/**
 * Recuperação de destinos travados em PUBLISHING, contra o Postgres real.
 *
 * O cenário: o worker morre entre marcar PUBLISHING e gravar o resultado.
 * Antes disso existir, o destino ficava preso para sempre — nenhum dos quatro
 * caminhos de recuperação o alcançava, a cota vazava, e a única saída era SQL
 * na mão.
 *
 * O teste que mais importa aqui é o de NÃO republicar: se a chamada à
 * plataforma chegou a sair, o desfecho é desconhecido e re-tentar poderia
 * publicar o mesmo conteúdo duas vezes. É a única coisa que este sistema não
 * pode fazer, e é o que separa "recuperar" de "estragar".
 */

let harness: TestHarness;

/** Fila falsa: o que interessa é o que foi (ou não foi) enfileirado. */
function filaFalsa() {
  const enfileirados: Array<{ jobId: string; postTargetId: string }> = [];

  return {
    enfileirados,
    fila: {
      add: async (_nome: string, dados: { postTargetId: string }, opts: { jobId: string }) => {
        enfileirados.push({ jobId: opts.jobId, postTargetId: dados.postTargetId });
      },
      remove: async () => undefined,
      getJob: async () => null,
    },
  };
}

/** Coloca o destino no estado exato de um worker morto no meio do envio. */
async function travarEmPublishing(
  postTargetId: string,
  organizationId: string,
  options: { minutosAtras: number; chegouAChamar: boolean },
): Promise<void> {
  const lastAttemptAt = new Date(Date.now() - options.minutosAtras * 60_000);

  await harness.prisma.postTarget.update({
    where: { id: postTargetId },
    data: { status: 'PUBLISHING', attempts: 1, lastAttemptAt, remoteId: null },
  });

  await harness.prisma.publishAttempt.create({
    data: {
      postTargetId,
      organizationId,
      attemptNumber: 1,
      startedAt: lastAttemptAt,
      // O worker morreu: nunca houve `finishedAt`.
      ...(options.chegouAChamar ? { externalCallStartedAt: lastAttemptAt } : {}),
    },
  });
}

beforeEach(async () => {
  harness = await createHarness('YOUTUBE');
});

afterEach(async () => {
  await harness.cleanup();
});

describe('caiu ANTES de falar com a plataforma', () => {
  it('reenfileira, porque é certo que nada foi publicado', async () => {
    const cenario = await createScenario(harness.prisma, { accountCount: 1 });
    const alvo = cenario.targets[0]!;
    await travarEmPublishing(alvo.id, cenario.organizationId, {
      minutosAtras: 30,
      chegouAChamar: false,
    });

    const { fila, enfileirados } = filaFalsa();
    const resultado = await recoverStuckPublishing(harness.container, fila as never);

    expect(resultado).toEqual({ reenfileirados: 1, inconclusivos: 0 });
    expect(enfileirados.map((job) => job.postTargetId)).toEqual([alvo.id]);

    const destino = await harness.prisma.postTarget.findUniqueOrThrow({ where: { id: alvo.id } });
    expect(destino.status).toBe('QUEUED');
    expect(destino.remoteId).toBeNull();
  });

  it('devolve a cota que ficou reservada', async () => {
    // A cota é reservada ANTES da chamada externa. Sem devolvê-la, cada
    // worker morto queima uma publicação do dia para sempre — e no YouTube
    // esse teto é do projeto inteiro, compartilhado entre todos os clientes.
    const cenario = await createScenario(harness.prisma, { accountCount: 1 });
    const alvo = cenario.targets[0]!;

    await harness.prisma.platformQuotaUsage.create({
      data: {
        platform: 'YOUTUBE',
        scopeKey: 'APP',
        windowDate: new Date(new Date().toISOString().slice(0, 10)),
        windowStart: new Date(Date.now() - 3_600_000),
        windowEnd: new Date(Date.now() + 3_600_000),
        count: 5,
        units: 5,
      },
    });

    await travarEmPublishing(alvo.id, cenario.organizationId, {
      minutosAtras: 30,
      chegouAChamar: false,
    });

    const { fila } = filaFalsa();
    await recoverStuckPublishing(harness.container, fila as never);

    const cota = await harness.prisma.platformQuotaUsage.findFirstOrThrow({
      where: { platform: 'YOUTUBE', scopeKey: 'APP' },
    });
    expect(cota.count).toBe(4);
  });
});

describe('caiu DURANTE a chamada', () => {
  it('NÃO reenfileira — publicar duas vezes é pior do que não publicar', async () => {
    const cenario = await createScenario(harness.prisma, { accountCount: 1 });
    const alvo = cenario.targets[0]!;
    await travarEmPublishing(alvo.id, cenario.organizationId, {
      minutosAtras: 30,
      chegouAChamar: true,
    });

    const { fila, enfileirados } = filaFalsa();
    const resultado = await recoverStuckPublishing(harness.container, fila as never);

    expect(resultado).toEqual({ reenfileirados: 0, inconclusivos: 1 });
    expect(enfileirados).toHaveLength(0);
  });

  it('destrava o destino e o deixa acionável, com o motivo explícito', async () => {
    // Ficar preso em PUBLISHING era o defeito: sem status acionável, nem
    // "tentar novamente" nem "cancelar" alcançavam o destino.
    const cenario = await createScenario(harness.prisma, { accountCount: 1 });
    const alvo = cenario.targets[0]!;
    await travarEmPublishing(alvo.id, cenario.organizationId, {
      minutosAtras: 30,
      chegouAChamar: true,
    });

    const { fila } = filaFalsa();
    await recoverStuckPublishing(harness.container, fila as never);

    const destino = await harness.prisma.postTarget.findUniqueOrThrow({ where: { id: alvo.id } });
    expect(destino.status).toBe('FAILED');
    expect(destino.errorCode).toBe('PUBLISH_INTERRUPTED_UNVERIFIED');
    expect(destino.errorMessage).toMatch(/duas vezes/i);
  });

  it('avisa quem pode conferir a conta', async () => {
    const cenario = await createScenario(harness.prisma, { accountCount: 1 });
    const alvo = cenario.targets[0]!;
    await travarEmPublishing(alvo.id, cenario.organizationId, {
      minutosAtras: 30,
      chegouAChamar: true,
    });

    const { fila } = filaFalsa();
    await recoverStuckPublishing(harness.container, fila as never);

    const aviso = await harness.prisma.notification.findFirst({
      where: { organizationId: cenario.organizationId, type: 'POST_FAILED' },
    });

    expect(aviso).not.toBeNull();
    expect(aviso?.title).toMatch(/interrompida/i);
  });
});

describe('o que NÃO deve ser tocado', () => {
  it('destino publicando há pouco tempo é deixado em paz', async () => {
    // Um upload de vídeo grande leva minutos e o lock do BullMQ ainda vale.
    // Recuperar aqui competiria com o processador que está trabalhando.
    const cenario = await createScenario(harness.prisma, { accountCount: 1 });
    const alvo = cenario.targets[0]!;
    await travarEmPublishing(alvo.id, cenario.organizationId, {
      minutosAtras: 3,
      chegouAChamar: false,
    });

    const { fila, enfileirados } = filaFalsa();
    const resultado = await recoverStuckPublishing(harness.container, fila as never);

    expect(resultado).toEqual({ reenfileirados: 0, inconclusivos: 0 });
    expect(enfileirados).toHaveLength(0);

    const destino = await harness.prisma.postTarget.findUniqueOrThrow({ where: { id: alvo.id } });
    expect(destino.status).toBe('PUBLISHING');
  });

  it('destino que já tem remoteId não é travado, é sucesso a caminho', async () => {
    const cenario = await createScenario(harness.prisma, { accountCount: 1 });
    const alvo = cenario.targets[0]!;
    await travarEmPublishing(alvo.id, cenario.organizationId, {
      minutosAtras: 30,
      chegouAChamar: true,
    });

    await harness.prisma.postTarget.update({
      where: { id: alvo.id },
      data: { remoteId: 'video-que-saiu' },
    });

    const { fila } = filaFalsa();
    const resultado = await recoverStuckPublishing(harness.container, fila as never);

    expect(resultado).toEqual({ reenfileirados: 0, inconclusivos: 0 });

    const destino = await harness.prisma.postTarget.findUniqueOrThrow({ where: { id: alvo.id } });
    expect(destino.status).toBe('PUBLISHING');
    expect(destino.remoteId).toBe('video-que-saiu');
  });
});

describe('isolamento entre destinos', () => {
  it('cada destino é decidido por si, na mesma rodada', async () => {
    // O princípio de sempre: 20 contas, e o desfecho de uma não contamina as
    // outras. Aqui um caiu antes da chamada e o outro durante.
    const cenario = await createScenario(harness.prisma, { accountCount: 2 });
    const [antes, durante] = cenario.targets;

    await travarEmPublishing(antes!.id, cenario.organizationId, {
      minutosAtras: 30,
      chegouAChamar: false,
    });
    await travarEmPublishing(durante!.id, cenario.organizationId, {
      minutosAtras: 30,
      chegouAChamar: true,
    });

    const { fila, enfileirados } = filaFalsa();
    const resultado = await recoverStuckPublishing(harness.container, fila as never);

    expect(resultado).toEqual({ reenfileirados: 1, inconclusivos: 1 });
    expect(enfileirados.map((job) => job.postTargetId)).toEqual([antes!.id]);

    const recuperado = await harness.prisma.postTarget.findUniqueOrThrow({
      where: { id: antes!.id },
    });
    const marcado = await harness.prisma.postTarget.findUniqueOrThrow({
      where: { id: durante!.id },
    });

    expect(recuperado.status).toBe('QUEUED');
    expect(marcado.status).toBe('FAILED');
  });
});
