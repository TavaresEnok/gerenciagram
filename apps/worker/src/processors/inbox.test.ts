import { randomUUID } from 'node:crypto';
import type { SyncInboxPayload } from '@app/core';
import type { Job } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { processSyncInbox, scanAccountsForInboxSync } from './inbox.js';
import { createHarness, createScenario, type TestHarness } from '../test/harness.js';

/**
 * Sincronização da inbox contra o Postgres real.
 *
 * O adapter é falso — não dá para ler comentários do YouTube num teste —, mas
 * banco, chave única e a lógica do processador são os de verdade. É
 * justamente aí que moram as garantias que interessam: não duplicar
 * comentário e não desfazer o trabalho de quem já respondeu.
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
    id: `inbox:${socialAccountId}`,
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

describe('sincronização da inbox', () => {
  it('grava os comentários das publicações recentes', async () => {
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

  it('rodar duas vezes NÃO duplica comentário', async () => {
    // A chave única (conta, id remoto) é o que garante isso. Sem ela, cada
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

  it('ressincronizar NÃO desmarca o que a equipe já leu e respondeu', async () => {
    // O estado de leitura é NOSSO, não da plataforma. Se a rodada seguinte o
    // sobrescrevesse, todo comentário já tratado voltaria para a fila.
    const cenario = await createScenario(harness.prisma, { accountCount: 1 });
    const alvo = cenario.targets[0]!;
    await publicar(alvo.id, 'video-1');

    harness.behavior.comments.set('video-1', [comentario('c1', 'Muito bom!')]);
    await processSyncInbox(harness.container, syncJob(alvo.accountId, cenario.organizationId));

    await harness.prisma.comment.updateMany({
      where: { socialAccountId: alvo.accountId },
      data: { isRead: true, isReplied: true, replyBody: 'Obrigado!', repliedAt: new Date() },
    });

    // A rede devolve o mesmo comentário, agora editado pelo autor.
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

  it('falha numa publicação não impede as outras', async () => {
    // Mesmo princípio do fan-out de publicação: a unidade de falha é o post,
    // não a conta inteira.
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

    harness.behavior.comments.set('video-1', new Error('vídeo removido na origem'));
    harness.behavior.comments.set('video-2', [comentario('c9', 'Comentário do segundo vídeo')]);

    await processSyncInbox(harness.container, syncJob(alvo.accountId, cenario.organizationId));

    const gravados = await harness.prisma.comment.findMany({
      where: { socialAccountId: alvo.accountId },
    });

    expect(gravados).toHaveLength(1);
    expect(gravados[0]?.remoteId).toBe('c9');
  });

  it('ignora conta que precisa de reconexão', async () => {
    const cenario = await createScenario(harness.prisma, { accountCount: 1 });
    const alvo = cenario.targets[0]!;
    await publicar(alvo.id, 'video-1');

    await harness.prisma.socialAccount.update({
      where: { id: alvo.accountId },
      data: { status: 'NEEDS_RECONNECT' },
    });

    harness.behavior.comments.set('video-1', [comentario('c1', 'Olá')]);
    await processSyncInbox(harness.container, syncJob(alvo.accountId, cenario.organizationId));

    expect(harness.behavior.commentCalls).toHaveLength(0);
    await expect(harness.prisma.comment.count()).resolves.toBe(0);
  });

  it('não gasta chamada quando a conta não tem publicação recente', async () => {
    // Uma conta recém-conectada não deve consumir cota da plataforma.
    const cenario = await createScenario(harness.prisma, { accountCount: 1 });

    await processSyncInbox(
      harness.container,
      syncJob(cenario.targets[0]!.accountId, cenario.organizationId),
    );

    expect(harness.behavior.commentCalls).toHaveLength(0);
  });
});

describe('varredura que enfileira as rodadas', () => {
  it('enfileira uma conta ativa por vez, com jobId determinístico', async () => {
    // O jobId fixo é o que impede duas réplicas do worker de sincronizarem a
    // mesma conta em paralelo, dobrando o consumo de cota.
    const cenario = await createScenario(harness.prisma, { accountCount: 3 });

    const enfileirados: Array<{ contaId: string; jobId: string }> = [];
    const total = await scanAccountsForInboxSync(harness.container, async (payload, jobId) => {
      enfileirados.push({ contaId: payload.socialAccountId, jobId });
    });

    expect(total).toBe(3);
    expect(enfileirados).toHaveLength(3);

    for (const item of enfileirados) {
      expect(item.jobId).toBe(`inbox:${item.contaId}`);
    }

    const ids = new Set(enfileirados.map((item) => item.contaId));
    expect(ids.size).toBe(3);
    expect(ids).toEqual(new Set(cenario.targets.map((alvo) => alvo.accountId)));
  });

  it('não enfileira conta desconectada', async () => {
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
