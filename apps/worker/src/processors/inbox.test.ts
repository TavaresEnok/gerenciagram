import { randomUUID } from 'node:crypto';
import type { SyncInboxPayload } from '@app/core';
import type { Job } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { processSyncInbox, scanAccountsForInboxSync } from './inbox.js';
import { createHarness, createScenario, type TestHarness } from '../test/harness.js';

/**
 * SincronizaÃ§Ã£o da inbox contra o Postgres real.
 *
 * O adapter Ã© falso â€” nÃ£o dÃ¡ para ler comentÃ¡rios do YouTube num teste â€”, mas
 * banco, chave Ãºnica e a lÃ³gica do processador sÃ£o os de verdade. Ã‰
 * justamente aÃ­ que moram as garantias que interessam: nÃ£o duplicar
 * comentÃ¡rio e nÃ£o desfazer o trabalho de quem jÃ¡ respondeu.
 */

let harness: TestHarness;

beforeEach(async () => {
  harness = await createHarness('YOUTUBE');
});

afterEach(async () => {
  await harness.cleanup();
});

function syncJob(socialAccountId: string, organizationId: string): Job<SyncInboxPayload> {
  return {
    id: `inbox_${socialAccountId}`,
    name: 'sync-inbox',
    data: {
      socialAccountId,
      organizationId,
      correlationId: `teste-${randomUUID().slice(0, 8)}`,
    },
  } as unknown as Job<SyncInboxPayload>;
}

/** Publica um destino para que ele entre na varredura da inbox. */
async function publicar(postTargetId: string, remoteId: string): Promise<void> {
  await harness.prisma.postTarget.update({
    where: { id: postTargetId },
    data: {
      status: 'PUBLISHED',
      remoteId,
      remoteUrl: `https://exemplo.invalid/${remoteId}`,
      publishedAt: new Date(),
    },
  });
}

function comentario(remoteId: string, body: string) {
  return {
    remoteId,
    body,
    postedAt: new Date(),
    authorUsername: 'espectador',
    authorRemoteId: 'autor-1',
  };
}

describe('sincronizaÃ§Ã£o da inbox', () => {
  it('grava os comentÃ¡rios das publicaÃ§Ãµes recentes', async () => {
    const cenario = await createScenario(harness.prisma, { accountCount: 1 });
    const alvo = cenario.targets[0]!;
    await publicar(alvo.id, 'video-1');

    harness.behavior.comments.set('video-1', [
      comentario('c1', 'Muito bom!'),
      comentario('c2', 'Faz um sobre X'),
    ]);

    await processSyncInbox(harness.container, syncJob(alvo.accountId, cenario.organizationId));

    const gravados = await harness.prisma.comment.findMany({
      where: { socialAccountId: alvo.accountId },
      orderBy: { remoteId: 'asc' },
    });

    expect(gravados).toHaveLength(2);
    expect(gravados[0]?.body).toBe('Muito bom!');
    expect(gravados[0]?.isRead).toBe(false);
    expect(gravados[0]?.platform).toBe('YOUTUBE');
  });

  it('rodar duas vezes NÃƒO duplica comentÃ¡rio', async () => {
    // A chave Ãºnica (conta, id remoto) Ã© o que garante isso. Sem ela, cada
    // rodada de 15 min multiplicaria a inbox.
    const cenario = await createScenario(harness.prisma, { accountCount: 1 });
    const alvo = cenario.targets[0]!;
    await publicar(alvo.id, 'video-1');

    harness.behavior.comments.set('video-1', [comentario('c1', 'Muito bom!')]);

    const job = syncJob(alvo.accountId, cenario.organizationId);
    await processSyncInbox(harness.container, job);
    await processSyncInbox(harness.container, job);

    await expect(
      harness.prisma.comment.count({ where: { socialAccountId: alvo.accountId } }),
    ).resolves.toBe(1);
  });

  it('ressincronizar NÃƒO desmarca o que a equipe jÃ¡ leu e respondeu', async () => {
    // O estado de leitura Ã© NOSSO, nÃ£o da plataforma. Se a rodada seguinte o
    // sobrescrevesse, todo comentÃ¡rio jÃ¡ tratado voltaria para a fila.
    const cenario = await createScenario(harness.prisma, { accountCount: 1 });
    const alvo = cenario.targets[0]!;
    await publicar(alvo.id, 'video-1');

    harness.behavior.comments.set('video-1', [comentario('c1', 'Muito bom!')]);
    await processSyncInbox(harness.container, syncJob(alvo.accountId, cenario.organizationId));

    await harness.prisma.comment.updateMany({
      where: { socialAccountId: alvo.accountId },
      data: { isRead: true, isReplied: true, replyBody: 'Obrigado!', repliedAt: new Date() },
    });

    // A rede devolve o mesmo comentÃ¡rio, agora editado pelo autor.
    harness.behavior.comments.set('video-1', [comentario('c1', 'Muito bom! (editado)')]);
    await processSyncInbox(harness.container, syncJob(alvo.accountId, cenario.organizationId));

    const gravado = await harness.prisma.comment.findFirst({
      where: { socialAccountId: alvo.accountId },
    });

    expect(gravado?.body).toBe('Muito bom! (editado)');
    expect(gravado?.isRead).toBe(true);
    expect(gravado?.isReplied).toBe(true);
    expect(gravado?.replyBody).toBe('Obrigado!');
  });

  it('falha numa publicaÃ§Ã£o nÃ£o impede as outras', async () => {
    // Mesmo princÃ­pio do fan-out de publicaÃ§Ã£o: a unidade de falha Ã© o post,
    // nÃ£o a conta inteira.
    const cenario = await createScenario(harness.prisma, { accountCount: 1 });
    const alvo = cenario.targets[0]!;
    await publicar(alvo.id, 'video-1');

    const outroPost = await harness.prisma.post.create({
      data: {
        organizationId: cenario.organizationId,
        clientId: cenario.clientId,
        contentId: cenario.contentId,
        createdById: cenario.userId,
        status: 'PUBLISHED',
      },
    });

    const segundo = await harness.prisma.postTarget.create({
      data: {
        organizationId: cenario.organizationId,
        postId: outroPost.id,
        socialAccountId: alvo.accountId,
        platform: 'YOUTUBE',
        status: 'PUBLISHED',
        remoteId: 'video-2',
        publishedAt: new Date(),
        idempotencyKey: `alvo:${outroPost.id}:${alvo.accountId}`,
      },
    });

    expect(segundo.remoteId).toBe('video-2');

    harness.behavior.comments.set('video-1', new Error('vÃ­deo removido na origem'));
    harness.behavior.comments.set('video-2', [comentario('c9', 'ComentÃ¡rio do segundo vÃ­deo')]);

    await processSyncInbox(harness.container, syncJob(alvo.accountId, cenario.organizationId));

    const gravados = await harness.prisma.comment.findMany({
      where: { socialAccountId: alvo.accountId },
    });

    expect(gravados).toHaveLength(1);
    expect(gravados[0]?.remoteId).toBe('c9');
  });

  it('ignora conta que precisa de reconexÃ£o', async () => {
    const cenario = await createScenario(harness.prisma, { accountCount: 1 });
    const alvo = cenario.targets[0]!;
    await publicar(alvo.id, 'video-1');

    await harness.prisma.socialAccount.update({
      where: { id: alvo.accountId },
      data: { status: 'NEEDS_RECONNECT' },
    });

    harness.behavior.comments.set('video-1', [comentario('c1', 'OlÃ¡')]);
    await processSyncInbox(harness.container, syncJob(alvo.accountId, cenario.organizationId));

    expect(harness.behavior.commentCalls).toHaveLength(0);
    await expect(harness.prisma.comment.count()).resolves.toBe(0);
  });

  it('nÃ£o gasta chamada quando a conta nÃ£o tem publicaÃ§Ã£o recente', async () => {
    // Uma conta recÃ©m-conectada nÃ£o deve consumir cota da plataforma.
    const cenario = await createScenario(harness.prisma, { accountCount: 1 });

    await processSyncInbox(
      harness.container,
      syncJob(cenario.targets[0]!.accountId, cenario.organizationId),
    );

    expect(harness.behavior.commentCalls).toHaveLength(0);
  });
});

describe('varredura que enfileira as rodadas', () => {
  it('enfileira uma conta ativa por vez, com jobId determinÃ­stico', async () => {
    // O jobId fixo Ã© o que impede duas rÃ©plicas do worker de sincronizarem a
    // mesma conta em paralelo, dobrando o consumo de cota.
    const cenario = await createScenario(harness.prisma, { accountCount: 3 });

    const enfileirados: Array<{ contaId: string; jobId: string }> = [];
    const total = await scanAccountsForInboxSync(harness.container, async (payload, jobId) => {
      enfileirados.push({ contaId: payload.socialAccountId, jobId });
    });

    expect(total).toBe(3);
    expect(enfileirados).toHaveLength(3);

    for (const item of enfileirados) {
      expect(item.jobId).toBe(`inbox_${item.contaId}`);
    }

    const ids = new Set(enfileirados.map((item) => item.contaId));
    expect(ids.size).toBe(3);
    expect(ids).toEqual(new Set(cenario.targets.map((alvo) => alvo.accountId)));
  });

  it('nÃ£o enfileira conta desconectada', async () => {
    const cenario = await createScenario(harness.prisma, { accountCount: 2 });

    await harness.prisma.socialAccount.update({
      where: { id: cenario.targets[0]!.accountId },
      data: { status: 'DISCONNECTED' },
    });

    const enfileirados: string[] = [];
    const total = await scanAccountsForInboxSync(harness.container, async (payload) => {
      enfileirados.push(payload.socialAccountId);
    });

    expect(total).toBe(1);
    expect(enfileirados).toEqual([cenario.targets[1]!.accountId]);
  });
});
