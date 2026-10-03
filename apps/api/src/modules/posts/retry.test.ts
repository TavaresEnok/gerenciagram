import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@app/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Container } from '../../container.js';
import type { AuthContext } from '../../plugins/auth.js';
import { PostService } from './service.js';

/**
 * "Tentar novamente" com resultado remoto desconhecido (o defeito: o retry
 * aceitava destinos PUBLISH_INTERRUPTED_UNVERIFIED como falha comum — e
 * reenviar uma criação que a rede pode ter aceito publica duas vezes).
 *
 * Prova-se aqui, contra Postgres real:
 *
 *  - falha CONFIRMADA volta para a fila normalmente;
 *  - resultado desconhecido SEM identificador de operação exige decisão
 *    humana explícita (ack), senão nem a fila é tocada;
 *  - com o ack, o retry acontece e a concordância fica na auditoria;
 *  - resultado desconhecido COM identificador de operação não recria nada:
 *    volta a PROCESSING e a VERIFICAÇÃO do estado remoto é reenfileirada.
 */

const prisma = new PrismaClient({
  datasources: { db: { url: process.env['DATABASE_URL_TEST'] as string } },
  log: ['warn', 'error'],
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Jobs enfileirados, para provar O QUE voltou à fila — e para quê. */
const enfileirados: Array<{ name: string; postTargetId: string }> = [];

function container(): Container {
  return {
    prisma,
    configuredPlatforms: new Set(['YOUTUBE']),
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    queues: {
      publish: {
        getJob: async () => null,
        add: async (name: string, data: { postTargetId: string }) => {
          enfileirados.push({ name, postTargetId: data.postTargetId });
        },
      },
    },
  } as unknown as Container;
}

interface Fixture {
  auth: AuthContext;
  organizationId: string;
  postId: string;
  targetId: string;
}

beforeEach(async () => {
  enfileirados.length = 0;

  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      publish_attempts, post_targets, posts, content_variants, content_media,
      contents, media_assets, media_folders, account_group_members,
      account_groups, posting_schedules, oauth_tokens, social_accounts,
      clients, memberships, sessions, users, organizations,
      platform_quota_usage, analytics_snapshots, dead_letter_jobs,
      notifications, audit_logs, comments
    RESTART IDENTITY CASCADE
  `);
});

async function criarFixture(errorCode: string | null, remoteOperationId: string | null = null): Promise<Fixture> {
  const organization = await prisma.organization.create({
    data: {
      name: 'Agência de teste',
      slug: `org-${randomUUID().slice(0, 8)}`,
      timezone: 'America/Sao_Paulo',
    },
  });

  const user = await prisma.user.create({
    data: { email: `dono-${randomUUID().slice(0, 8)}@exemplo.invalid`, name: 'Dono' },
  });

  await prisma.membership.create({
    data: { organizationId: organization.id, userId: user.id, role: 'OWNER' },
  });

  const client = await prisma.client.create({
    data: {
      organizationId: organization.id,
      name: 'Cliente',
      slug: `cliente-${randomUUID().slice(0, 8)}`,
      timezone: 'America/Sao_Paulo',
    },
  });

  const account = await prisma.socialAccount.create({
    data: {
      organizationId: organization.id,
      clientId: client.id,
      platform: 'YOUTUBE',
      remoteId: `canal-${randomUUID().slice(0, 6)}`,
      nickname: 'Canal 1',
      remoteDisplayName: 'Canal 1',
      timezone: 'America/Sao_Paulo',
      status: 'ACTIVE',
    },
  });

  const content = await prisma.content.create({
    data: {
      organizationId: organization.id,
      clientId: client.id,
      createdById: user.id,
      body: 'Corpo de teste.',
    },
  });

  const post = await prisma.post.create({
    data: {
      organizationId: organization.id,
      clientId: client.id,
      contentId: content.id,
      createdById: user.id,
      status: 'FAILED',
    },
  });

  const target = await prisma.postTarget.create({
    data: {
      organizationId: organization.id,
      postId: post.id,
      socialAccountId: account.id,
      platform: 'YOUTUBE',
      status: 'FAILED',
      idempotencyKey: `idem-${randomUUID()}`,
      errorCode,
      errorMessage: 'falhou',
      errorPermanent: errorCode !== null && errorCode !== 'PLATFORM_TIMEOUT',
      ...(remoteOperationId !== null ? { remoteOperationId } : {}),
    },
  });

  return {
    auth: {
      userId: user.id,
      organizationId: organization.id,
      role: 'OWNER',
      scopedClientIds: [],
      mfaSatisfied: true,
    },
    organizationId: organization.id,
    postId: post.id,
    targetId: target.id,
  };
}

describe('retry de destinos com falha', () => {
  it('falha confirmada volta à fila de publicação normalmente', async () => {
    const cenario = await criarFixture('REMOTE_REJECTED');
    const service = new PostService(container());

    const resultado = await service.retryFailed(cenario.auth, cenario.postId, 'teste');

    expect(resultado.retried).toBe(1);
    expect(resultado.resumedVerification).toBe(0);
    expect(enfileirados).toEqual([{ name: 'publish-target', postTargetId: cenario.targetId }]);

    const destino = await prisma.postTarget.findUniqueOrThrow({ where: { id: cenario.targetId } });
    expect(destino.status).toBe('QUEUED');
  });

  it('resultado desconhecido SEM ack: recusa, sem tocar em nada', async () => {
    const cenario = await criarFixture('PUBLISH_INTERRUPTED_UNVERIFIED');
    const service = new PostService(container());

    const falha = await service
      .retryFailed(cenario.auth, cenario.postId, 'teste')
      .then(() => null)
      .catch((erro: unknown) => erro);

    expect(falha).toBeInstanceOf(Error);
    expect((falha as { details?: { code?: string } }).details?.code).toBe(
      'UNVERIFIED_RETRY_REQUIRES_ACK',
    );
    expect((falha as Error).message).toMatch(/duas vezes/i);

    // Nenhum job, nenhum estado mudado.
    expect(enfileirados).toHaveLength(0);
    const destino = await prisma.postTarget.findUniqueOrThrow({ where: { id: cenario.targetId } });
    expect(destino.status).toBe('FAILED');
  });

  it('resultado desconhecido COM ack: volta à fila e a concordância vai para a auditoria', async () => {
    const cenario = await criarFixture('PUBLISH_INTERRUPTED_UNVERIFIED');
    const service = new PostService(container());

    const resultado = await service.retryFailed(cenario.auth, cenario.postId, 'teste', undefined, {
      acknowledgeUnverified: true,
    });

    expect(resultado.retried).toBe(1);
    expect(enfileirados).toEqual([{ name: 'publish-target', postTargetId: cenario.targetId }]);

    const auditoria = await prisma.auditLog.findFirstOrThrow({
      where: { organizationId: cenario.organizationId, action: 'post.retry_failed' },
    });
    expect((auditoria.changes as { reconheceuResultadoDesconhecido?: boolean })
      ?.reconheceuResultadoDesconhecido).toBe(true);
  });

  it('desconhecido COM operação remota: retoma a VERIFICAÇÃO, sem novo upload', async () => {
    const cenario = await criarFixture('REMOTE_PROCESSING_TIMEOUT', 'publish-id-123');
    const service = new PostService(container());

    const resultado = await service.retryFailed(cenario.auth, cenario.postId, 'teste');

    expect(resultado.retried).toBe(0);
    expect(resultado.resumedVerification).toBe(1);

    // Foi para a fila de VERIFICAÇÃO, nunca para a de publicação.
    expect(enfileirados).toEqual([{ name: 'check-remote-state', postTargetId: cenario.targetId }]);

    const destino = await prisma.postTarget.findUniqueOrThrow({ where: { id: cenario.targetId } });
    expect(destino.status).toBe('PROCESSING');
    expect(destino.remoteOperationId).toBe('publish-id-123');
    expect(destino.processingDeadlineAt).not.toBeNull();
  });
});
