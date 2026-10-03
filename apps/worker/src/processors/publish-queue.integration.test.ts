import {
  JOB_PUBLISH_TARGET,
  QuotaExceededError,
  publishJobId,
} from '@app/core';
import { Queue, Worker, type Job } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, createScenario, type TestHarness } from '../test/harness.js';
import { processPublishTarget } from './publish.js';

/**
 * Integração com BullMQ REAL (Redis do docker compose, prefixo `grs-test`):
 * o motivo de existir deste arquivo é que o fakeJob dos testes unitários NÃO
 * reproduz a máquina de estados da fila — e foi essa diferença que escondeu
 * o defeito do `changeDelay` (chamado num job ATIVO, em que o BullMQ lança
 * JobNotInState e a fila re-tentaria no horário errado, gastando tentativa).
 *
 * O que é provado aqui, com Queue + Worker de verdade:
 *  - cota estourada: o job vai para DELAYED até o reset, NÃO publica, NÃO
 *    consome tentativa e reaparece sozinho no horário — uma vez só;
 *  - circuito aberto: idem para a janela de retry do breaker.
 */

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6380';
const PREFIX = 'grs-test';

let harness: TestHarness;
let queue: Queue;
let worker: Worker | undefined;

beforeEach(async () => {
  harness = await createHarness('YOUTUBE');
  queue = new Queue('publish', {
    connection: { url: REDIS_URL, maxRetriesPerRequest: null },
    prefix: PREFIX,
  });
  await queue.drain(true);
});

afterEach(async () => {
  await worker?.close();
  worker = undefined;
  await queue.obliterate({ force: true }).catch(() => undefined);
  await queue.close();
  await harness.cleanup();
});

function ligarWorker(): Worker {
  const instancia = new Worker(
    'publish',
    async (job: Job) => {
      await processPublishTarget(harness.container, job as never, async () => undefined);
    },
    {
      connection: { url: REDIS_URL, maxRetriesPerRequest: null },
      prefix: PREFIX,
      lockDuration: 30_000,
    },
  );
  worker = instancia;
  return instancia;
}

async function aguardar<T>(buscar: () => Promise<T>, aceitar: (valor: T) => boolean): Promise<T> {
  const limite = Date.now() + 25_000;
  for (;;) {
    const valor = await buscar();
    if (aceitar(valor)) return valor;
    if (Date.now() > limite) throw new Error('condição não atingida no prazo do teste');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe('cota estourada contra BullMQ real', () => {
  it('o job NÃO é concluído: vai para delayed, reaparece no reset e publica uma vez', async () => {
    const cenario = await createScenario(harness.prisma, { accountCount: 1 });
    const alvo = cenario.targets[0]!;
    const reset = new Date(Date.now() + 1_500);

    // A primeira execução estoura a cota; a segunda (após o reset) publica.
    harness.behavior.responses.push(
      new QuotaExceededError('YouTube', 'APP', reset),
      { remoteId: 'video-depois-do-reset' },
    );

    await queue.add(
      JOB_PUBLISH_TARGET,
      {
        postTargetId: alvo.id,
        organizationId: cenario.organizationId,
        platform: 'YOUTUBE',
        idempotencyKey: 'chave',
        correlationId: 'teste-cota',
      },
      { jobId: publishJobId(alvo.id), attempts: 3 },
    );

    ligarWorker();

    // Primeiro observa o período adiado: nada de publicação antes do reset.
    const trabalho = await queue.getJob(publishJobId(alvo.id));
    await aguardar(
      () => trabalho!.getState(),
      (estado) => estado === 'delayed',
    );
    expect(harness.behavior.calls).toHaveLength(1);

    // A ESPERA não consumiu tentativa do BullMQ (moveToDelayed usa
    // skipAttempt). É isto que o changeDelay quebrado não garantia: cada
    // ciclada era contabilizada como falha e gastava o orçamento de retry.
    expect(trabalho!.attemptsMade).toBe(0);

    const destinoAdiado = await harness.prisma.postTarget.findUniqueOrThrow({
      where: { id: alvo.id },
    });
    expect(destinoAdiado.status).toBe('SCHEDULED');
    expect(Math.abs(destinoAdiado.scheduledAt!.getTime() - reset.getTime())).toBeLessThan(2_000);
    // A tentativa foi desfeita: não houve falha de publicação, houve
    // decisão nossa de não tentar ainda.
    expect(destinoAdiado.attempts).toBe(0);

    // Depois do reset, o MESMO job volta sozinho e conclui a publicação.
    const destinoFinal = await aguardar(
      () => harness.prisma.postTarget.findUniqueOrThrow({ where: { id: alvo.id } }),
      (destino) => destino.status === 'PUBLISHED',
    );

    expect(destinoFinal.remoteId).toBe('video-depois-do-reset');
    // Duas chamadas externas no total (a barrada pela cota e a final) — e
    // nenhuma publicação duplicada.
    expect(harness.behavior.calls).toHaveLength(2);
  });
});

describe('circuito aberto contra BullMQ real', () => {
  it('o job espera a janela do breaker sem publicar nem consumir tentativa', async () => {
    const cenario = await createScenario(harness.prisma, { accountCount: 1 });
    const alvo = cenario.targets[0]!;

    // Circuito aberto com a janela terminando daqui a ~1,5s.
    // openDurationMs padrão = 5 min; openedAt no passado encurta a espera
    // sem mudar a regra.
    await harness.prisma.socialPlatform.update({
      where: { key: 'YOUTUBE' },
      data: {
        circuitState: 'OPEN',
        circuitFailureCount: 5,
        circuitOpenedAt: new Date(Date.now() - (5 * 60_000 - 1_500)),
      },
    });

    harness.behavior.responses.push({ remoteId: 'video-depois-do-circuito' });

    await queue.add(
      JOB_PUBLISH_TARGET,
      {
        postTargetId: alvo.id,
        organizationId: cenario.organizationId,
        platform: 'YOUTUBE',
        idempotencyKey: 'chave',
        correlationId: 'teste-circuito',
      },
      { jobId: publishJobId(alvo.id), attempts: 3 },
    );

    ligarWorker();

    // Com o circuito aberto, a plataforma NÃO é chamada.
    const trabalho = await queue.getJob(publishJobId(alvo.id));
    await aguardar(
      () => trabalho!.getState(),
      (estado) => estado === 'delayed',
    );
    expect(harness.behavior.calls).toHaveLength(0);
    // A espera não consumiu tentativa do BullMQ.
    expect(trabalho!.attemptsMade).toBe(0);

    const destinoAdiado = await harness.prisma.postTarget.findUniqueOrThrow({
      where: { id: alvo.id },
    });
    expect(destinoAdiado.status).toBe('SCHEDULED');
    expect(destinoAdiado.errorCode).toBe('CIRCUIT_OPEN');

    // Passada a janela do breaker, o job roda de novo e publica.
    const destinoFinal = await aguardar(
      () => harness.prisma.postTarget.findUniqueOrThrow({ where: { id: alvo.id } }),
      (destino) => destino.status === 'PUBLISHED',
    );
    expect(destinoFinal.remoteId).toBe('video-depois-do-circuito');
    expect(harness.behavior.calls).toHaveLength(1);
  });
});
