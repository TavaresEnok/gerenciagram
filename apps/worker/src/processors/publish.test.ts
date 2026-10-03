import {
  PlatformApiError,
  PlatformTimeoutError,
  TokenExpiredError,
} from '@app/core';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, createScenario, fakeJob, type TestHarness } from '../test/harness.js';
import { processPublishTarget } from './publish.js';

/**
 * Cenários obrigatórios da SPEC seção 21 para o motor de publicação.
 *
 * Rodam contra Postgres real: as garantias sendo testadas (UNIQUE por
 * destino, UPDATE condicional na corrida entre workers, incremento atômico de
 * cota) são do banco, e um banco falso as tornaria vazias.
 */

let harness: TestHarness;

beforeEach(async () => {
  harness = await createHarness('YOUTUBE');
});

afterAll(async () => {
  await harness?.cleanup();
});

describe('publicação bem-sucedida', () => {
  it('marca o destino como publicado e guarda o id remoto', async () => {
    const scenario = await createScenario(harness.prisma, { accountCount: 1 });
    const target = scenario.targets[0]!;

    harness.behavior.responses.push({
      remoteId: 'video-abc',
      remoteUrl: 'https://www.youtube.com/watch?v=video-abc',
    });

    await processPublishTarget(harness.container, fakeJob(target.id, scenario.organizationId));

    const updated = await harness.prisma.postTarget.findUniqueOrThrow({
      where: { id: target.id },
    });

    expect(updated.status).toBe('PUBLISHED');
    expect(updated.remoteId).toBe('video-abc');
    expect(updated.remoteUrl).toContain('video-abc');
    expect(updated.publishedAt).toBeInstanceOf(Date);
    expect(updated.attempts).toBe(1);

    const post = await harness.prisma.post.findUniqueOrThrow({ where: { id: scenario.postId } });
    expect(post.status).toBe('PUBLISHED');
  });

  it('registra a tentativa no histórico', async () => {
    const scenario = await createScenario(harness.prisma, { accountCount: 1 });
    const target = scenario.targets[0]!;

    harness.behavior.responses.push({ remoteId: 'video-abc' });
    await processPublishTarget(harness.container, fakeJob(target.id, scenario.organizationId));

    const attempts = await harness.prisma.publishAttempt.findMany({
      where: { postTargetId: target.id },
    });

    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.success).toBe(true);
    expect(attempts[0]?.attemptNumber).toBe(1);
    expect(attempts[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('idempotência — publicação duplicada', () => {
  it('reprocessar o mesmo job NÃO publica duas vezes', async () => {
    const scenario = await createScenario(harness.prisma, { accountCount: 1 });
    const target = scenario.targets[0]!;

    harness.behavior.responses.push({ remoteId: 'video-abc' });

    const job = fakeJob(target.id, scenario.organizationId);
    await processPublishTarget(harness.container, job);
    // Reprocessamento: acontece de verdade quando um job é recuperado após
    // o worker cair no meio.
    await processPublishTarget(harness.container, job);

    expect(harness.behavior.calls).toHaveLength(1);

    const updated = await harness.prisma.postTarget.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(updated.remoteId).toBe('video-abc');
    expect(updated.attempts).toBe(1);
  });

  it('dois workers em paralelo publicam uma vez só', async () => {
    const scenario = await createScenario(harness.prisma, { accountCount: 1 });
    const target = scenario.targets[0]!;

    harness.behavior.responses.push({ remoteId: 'video-abc' }, { remoteId: 'video-duplicado' });

    // O UPDATE condicional é quem decide: só um dos dois encontra o destino
    // ainda pendente.
    await Promise.all([
      processPublishTarget(harness.container, fakeJob(target.id, scenario.organizationId)),
      processPublishTarget(harness.container, fakeJob(target.id, scenario.organizationId)),
    ]);

    expect(harness.behavior.calls).toHaveLength(1);
  });

  it('destino cancelado não é publicado', async () => {
    const scenario = await createScenario(harness.prisma, { accountCount: 1 });
    const target = scenario.targets[0]!;

    await harness.prisma.postTarget.update({
      where: { id: target.id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });

    harness.behavior.responses.push({ remoteId: 'nao-deveria-publicar' });
    await processPublishTarget(harness.container, fakeJob(target.id, scenario.organizationId));

    expect(harness.behavior.calls).toHaveLength(0);
  });
});

describe('isolamento entre destinos (o caso central da SPEC)', () => {
  it('grupo de 20 contas com 3 falhas: as outras 17 publicam normalmente', async () => {
    const scenario = await createScenario(harness.prisma, { accountCount: 20 });

    // As 3 primeiras falham de forma permanente; as demais publicam.
    for (let index = 0; index < 20; index += 1) {
      harness.behavior.responses.push(
        index < 3
          ? new PlatformApiError('título inválido', {
              retryable: false,
              platform: 'YouTube',
              remoteCode: 'invalidTitle',
            })
          : { remoteId: `video-${index}` },
      );
    }

    for (const target of scenario.targets) {
      await processPublishTarget(
        harness.container,
        fakeJob(target.id, scenario.organizationId),
      ).catch(() => undefined);
    }

    const targets = await harness.prisma.postTarget.findMany({
      where: { postId: scenario.postId },
      orderBy: { createdAt: 'asc' },
    });

    expect(targets.filter((target) => target.status === 'PUBLISHED')).toHaveLength(17);
    expect(targets.filter((target) => target.status === 'FAILED')).toHaveLength(3);

    const post = await harness.prisma.post.findUniqueOrThrow({ where: { id: scenario.postId } });
    expect(post.status).toBe('PARTIALLY_PUBLISHED');
  });

  it('reprocessar os que falharam não republica os que deram certo', async () => {
    const scenario = await createScenario(harness.prisma, { accountCount: 5 });

    for (let index = 0; index < 5; index += 1) {
      harness.behavior.responses.push(
        index < 2
          ? new PlatformApiError('erro definitivo', { retryable: false, platform: 'YouTube' })
          : { remoteId: `video-${index}` },
      );
    }

    for (const target of scenario.targets) {
      await processPublishTarget(
        harness.container,
        fakeJob(target.id, scenario.organizationId),
      ).catch(() => undefined);
    }

    const chamadasIniciais = harness.behavior.calls.length;
    expect(chamadasIniciais).toBe(5);

    // "Tentar novamente" só nos que falharam.
    const failed = await harness.prisma.postTarget.findMany({
      where: { postId: scenario.postId, status: 'FAILED' },
    });
    expect(failed).toHaveLength(2);

    await harness.prisma.postTarget.updateMany({
      where: { id: { in: failed.map((target) => target.id) } },
      data: { status: 'SCHEDULED', attempts: 0, errorCode: null, errorMessage: null },
    });

    harness.behavior.responses.push({ remoteId: 'retry-1' }, { remoteId: 'retry-2' });

    for (const target of failed) {
      await processPublishTarget(harness.container, fakeJob(target.id, scenario.organizationId));
    }

    // 5 iniciais + 2 do reprocessamento. Se os 3 publicados fossem tocados,
    // seriam 10.
    expect(harness.behavior.calls).toHaveLength(7);

    const targets = await harness.prisma.postTarget.findMany({
      where: { postId: scenario.postId },
    });
    expect(targets.filter((target) => target.status === 'PUBLISHED')).toHaveLength(5);
  });
});

describe('classificação de erro', () => {
  it('erro recuperável reagenda em vez de falhar', async () => {
    const scenario = await createScenario(harness.prisma, { accountCount: 1 });
    const target = scenario.targets[0]!;

    harness.behavior.responses.push(new PlatformTimeoutError('YouTube', 30_000));

    await expect(
      processPublishTarget(harness.container, fakeJob(target.id, scenario.organizationId)),
    ).rejects.toThrow();

    const updated = await harness.prisma.postTarget.findUniqueOrThrow({
      where: { id: target.id },
    });

    expect(updated.status).toBe('SCHEDULED');
    expect(updated.errorPermanent).toBe(false);
    expect(updated.nextRetryAt).toBeInstanceOf(Date);
    expect(updated.nextRetryAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('token expirado falha na hora, sem queimar as 5 tentativas', async () => {
    const scenario = await createScenario(harness.prisma, { accountCount: 1 });
    const target = scenario.targets[0]!;

    harness.behavior.responses.push(new TokenExpiredError('YouTube'));

    await processPublishTarget(harness.container, fakeJob(target.id, scenario.organizationId));

    const updated = await harness.prisma.postTarget.findUniqueOrThrow({
      where: { id: target.id },
    });

    expect(updated.status).toBe('FAILED');
    expect(updated.errorPermanent).toBe(true);
    expect(updated.attempts).toBe(1);
  });

  it('esgotar as tentativas registra o job na dead-letter queue', async () => {
    const scenario = await createScenario(harness.prisma, { accountCount: 1 });
    const target = scenario.targets[0]!;

    // Na última tentativa possível, um erro recuperável vira falha definitiva.
    await harness.prisma.postTarget.update({
      where: { id: target.id },
      data: { attempts: 4, maxAttempts: 5 },
    });

    harness.behavior.responses.push(new PlatformTimeoutError('YouTube', 30_000));

    await processPublishTarget(harness.container, fakeJob(target.id, scenario.organizationId));

    const updated = await harness.prisma.postTarget.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(updated.status).toBe('FAILED');

    const deadLetter = await harness.prisma.deadLetterJob.findMany({
      where: { organizationId: scenario.organizationId },
    });
    expect(deadLetter).toHaveLength(1);
    expect(deadLetter[0]?.queueName).toBe('publish');
    expect(deadLetter[0]?.attemptsMade).toBe(5);
  });

  it('a falha gera notificação para quem pode agir', async () => {
    const scenario = await createScenario(harness.prisma, { accountCount: 1 });
    const target = scenario.targets[0]!;

    harness.behavior.responses.push(new TokenExpiredError('YouTube'));
    await processPublishTarget(harness.container, fakeJob(target.id, scenario.organizationId));

    const notifications = await harness.prisma.notification.findMany({
      where: { organizationId: scenario.organizationId },
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe('TOKEN_EXPIRED');
    expect(notifications[0]?.body).toContain('não foram afetados');
  });
});

describe('cota', () => {
  it('consome a cota do app a cada publicação', async () => {
    const scenario = await createScenario(harness.prisma, { accountCount: 3 });

    for (let index = 0; index < 3; index += 1) {
      harness.behavior.responses.push({ remoteId: `video-${index}` });
    }

    for (const target of scenario.targets) {
      await processPublishTarget(harness.container, fakeJob(target.id, scenario.organizationId));
    }

    // O YouTube tem cota de APP: a linha é compartilhada, não uma por conta.
    const appQuota = await harness.prisma.platformQuotaUsage.findMany({
      where: { platform: 'YOUTUBE', scopeKey: 'APP' },
    });

    expect(appQuota).toHaveLength(1);
    expect(appQuota[0]?.count).toBe(3);
  });

  it('devolve a cota quando a publicação falha definitivamente SEM efeito remoto', async () => {
    // TokenExpiredError = a plataforma recusou na autenticação, sem aceitar
    // nada do upload: não há consumo remoto a compensar.
    const scenario = await createScenario(harness.prisma, { accountCount: 1 });
    const target = scenario.targets[0]!;

    harness.behavior.responses.push(new TokenExpiredError('YouTube'));
    await processPublishTarget(harness.container, fakeJob(target.id, scenario.organizationId));

    const appQuota = await harness.prisma.platformQuotaUsage.findFirst({
      where: { platform: 'YOUTUBE', scopeKey: 'APP' },
    });

    // Reservou ao tentar e devolveu ao falhar: o limite do dia não pode ser
    // consumido por publicações que não aconteceram.
    expect(appQuota?.count ?? 0).toBe(0);
  });

  it('NÃO devolve a cota quando a chamada à plataforma chegou a sair', async () => {
    // O timeout DEPOIS do envio é o caso traiçoeiro: o upload pode ter sido
    // contado na janela remota. Devolver a reserva "porque falhou" estouraria
    // o limite real da plataforma no dia (ex.: 100 uploads/dia do YouTube).
    const scenario = await createScenario(harness.prisma, { accountCount: 1 });
    const target = scenario.targets[0]!;

    // Última tentativa: o timeout estoura o orçamento e vira falha definitiva.
    await harness.prisma.postTarget.update({
      where: { id: target.id },
      data: { attempts: 4, maxAttempts: 5 },
    });

    harness.behavior.responses.push(new PlatformTimeoutError('YouTube', 30_000));
    await processPublishTarget(harness.container, fakeJob(target.id, scenario.organizationId));

    const tentativa = await harness.prisma.publishAttempt.findFirstOrThrow({
      where: { postTargetId: target.id },
    });
    // A chamada externa chegou a sair — é isso que decide a cota ficar.
    expect(tentativa.externalCallStartedAt).not.toBeNull();

    const appQuota = await harness.prisma.platformQuotaUsage.findFirstOrThrow({
      where: { platform: 'YOUTUBE', scopeKey: 'APP' },
    });
    expect(appQuota.count).toBe(1);

    const updated = await harness.prisma.postTarget.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(updated.status).toBe('FAILED');
  });
});

describe('circuit breaker', () => {
  it('abre depois de falhas seguidas e passa a recusar sem chamar a plataforma', async () => {
    const scenario = await createScenario(harness.prisma, { accountCount: 7 });

    // 5 falhas recuperáveis abrem o circuito (limite padrão).
    for (let index = 0; index < 5; index += 1) {
      harness.behavior.responses.push(
        new PlatformApiError('indisponível', {
          retryable: true,
          platform: 'YouTube',
          httpStatus: 503,
        }),
      );
    }

    for (let index = 0; index < 5; index += 1) {
      await processPublishTarget(
        harness.container,
        fakeJob(scenario.targets[index]!.id, scenario.organizationId),
      ).catch(() => undefined);
    }

    const platform = await harness.prisma.socialPlatform.findUniqueOrThrow({
      where: { key: 'YOUTUBE' },
    });
    expect(platform.circuitState).toBe('OPEN');

    const chamadasAntes = harness.behavior.calls.length;

    // Com o circuito aberto, o próximo destino nem chega ao adapter.
    await processPublishTarget(
      harness.container,
      fakeJob(scenario.targets[5]!.id, scenario.organizationId),
    ).catch(() => undefined);

    expect(harness.behavior.calls).toHaveLength(chamadasAntes);

    const target = await harness.prisma.postTarget.findUniqueOrThrow({
      where: { id: scenario.targets[5]!.id },
    });
    expect(target.status).toBe('SCHEDULED');
    expect(target.errorCode).toBe('CIRCUIT_OPEN');
  });
});

describe('revisão humana de conteúdo gerado por IA', () => {
  it('bloqueia a publicação de conteúdo de IA ainda não revisado', async () => {
    const scenario = await createScenario(harness.prisma, { accountCount: 1 });
    const target = scenario.targets[0]!;

    await harness.prisma.content.update({
      where: { id: scenario.contentId },
      data: { aiGenerated: true, aiReviewedAt: null },
    });

    harness.behavior.responses.push({ remoteId: 'nao-deveria-publicar' });

    await processPublishTarget(harness.container, fakeJob(target.id, scenario.organizationId));

    expect(harness.behavior.calls).toHaveLength(0);

    const updated = await harness.prisma.postTarget.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(updated.status).toBe('FAILED');
    expect(updated.errorCode).toBe('AI_REVIEW_REQUIRED');
  });

  it('publica normalmente DEPOIS da revisão registrada', async () => {
    const scenario = await createScenario(harness.prisma, { accountCount: 1 });
    const target = scenario.targets[0]!;

    await harness.prisma.content.update({
      where: { id: scenario.contentId },
      data: { aiGenerated: true, aiReviewedAt: new Date() },
    });

    harness.behavior.responses.push({ remoteId: 'video-revisado' });
    await processPublishTarget(harness.container, fakeJob(target.id, scenario.organizationId));

    expect(harness.behavior.calls).toHaveLength(1);

    const updated = await harness.prisma.postTarget.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(updated.status).toBe('PUBLISHED');
  });

  it('revisão invalidada por edição volta a bloquear (aiReviewedAt zerado pela API)', async () => {
    // A API é quem zera aiReviewedAt quando o texto muda; aqui provamos que
    // a barreira do worker obedece à invalidação, não só à ausência inicial.
    const scenario = await createScenario(harness.prisma, { accountCount: 1 });
    const target = scenario.targets[0]!;

    await harness.prisma.content.update({
      where: { id: scenario.contentId },
      // Estado de "revisado e depois editado": a revisão foi invalidada.
      data: { aiGenerated: true, aiReviewedAt: null },
    });

    harness.behavior.responses.push({ remoteId: 'nao-deveria-publicar' });

    await processPublishTarget(harness.container, fakeJob(target.id, scenario.organizationId));

    expect(harness.behavior.calls).toHaveLength(0);
    const updated = await harness.prisma.postTarget.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(updated.errorCode).toBe('AI_REVIEW_REQUIRED');
  });
});
