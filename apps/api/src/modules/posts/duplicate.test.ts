import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@app/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Container } from '../../container.js';
import type { AuthContext } from '../../plugins/auth.js';
import { PostService } from './service.js';

/**
 * Reaproveitamento de conteúdo, contra o Postgres de teste.
 *
 * O que precisa ser provado aqui não aparece num banco falso: que a cópia
 * NÃO compartilha a linha de `Content` com a original (senão editar a
 * republicação reescreveria um post que já saiu no ar) e que os destinos vêm
 * dos `PostTarget` da origem, e não de uma reexpansão do grupo.
 */

const prisma = new PrismaClient({
  datasources: { db: { url: process.env['DATABASE_URL_TEST'] as string } },
  log: ['warn', 'error'],
});

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * Container mínimo: só o que o compositor toca. Sem fila, porque todo teste
 * daqui cria RASCUNHO — sem agendamento, nada é enfileirado.
 */
function container(): Container {
  return {
    prisma,
    configuredPlatforms: new Set(['YOUTUBE']),
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as unknown as Container;
}

interface Fixture {
  auth: AuthContext;
  organizationId: string;
  clientId: string;
  contentId: string;
  groupId: string;
  accountIds: string[];
}

beforeEach(async () => {
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

  await prisma.socialPlatform.updateMany({
    where: { key: 'YOUTUBE' },
    data: { isAvailable: true, credentialsConfigured: true },
  });
});

async function criarCenario(options: { contas: number }): Promise<Fixture> {
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

  const group = await prisma.accountGroup.create({
    data: { organizationId: organization.id, name: 'Curiosidades' },
  });

  const accountIds: string[] = [];
  for (let index = 0; index < options.contas; index += 1) {
    const account = await prisma.socialAccount.create({
      data: {
        organizationId: organization.id,
        clientId: client.id,
        platform: 'YOUTUBE',
        remoteId: `canal-${index}-${randomUUID().slice(0, 6)}`,
        nickname: `Canal ${index + 1}`,
        remoteDisplayName: `Canal ${index + 1}`,
        timezone: 'America/Sao_Paulo',
        status: 'ACTIVE',
      },
    });

    await prisma.accountGroupMember.create({
      data: {
        organizationId: organization.id,
        accountGroupId: group.id,
        socialAccountId: account.id,
      },
    });

    accountIds.push(account.id);
  }

  // O YouTube exige vídeo: sem mídia pronta, todo destino sairia bloqueado e
  // o teste provaria só a validação, não a duplicação.
  const media = await prisma.mediaAsset.create({
    data: {
      organizationId: organization.id,
      clientId: client.id,
      filename: 'video.mp4',
      originalFilename: 'video.mp4',
      mimeType: 'video/mp4',
      type: 'VIDEO',
      sizeBytes: BigInt(5_000_000),
      storageKey: `org/${organization.id}/${randomUUID()}.mp4`,
      checksum: randomUUID().replace(/-/g, ''),
      width: 1920,
      height: 1080,
      durationMs: 60_000,
      processingStatus: 'READY',
    },
  });

  const content = await prisma.content.create({
    data: {
      organizationId: organization.id,
      clientId: client.id,
      createdById: user.id,
      title: 'Título original',
      body: 'Corpo original.',
      hashtags: ['original'],
      media: { create: [{ mediaAssetId: media.id, position: 0, role: 'MAIN' }] },
      variants: {
        create: [
          {
            organizationId: organization.id,
            platform: 'YOUTUBE',
            title: 'Título do YouTube',
            body: 'Corpo do YouTube.',
            hashtags: ['youtube'],
            platformFields: { privacyStatus: 'public', categoryId: '22', madeForKids: false },
          },
        ],
      },
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
    clientId: client.id,
    contentId: content.id,
    groupId: group.id,
    accountIds,
  };
}

describe('duplicar publicação', () => {
  it('copia o conteúdo com mídia e variações, e liga a cópia à origem', async () => {
    const cenario = await criarCenario({ contas: 2 });
    const service = new PostService(container());

    const original = await service.create(
      cenario.auth,
      { contentId: cenario.contentId, selection: { groupIds: [cenario.groupId] } },
      'teste',
    );

    const copia = await service.duplicate(cenario.auth, original.postId, {}, 'teste');

    expect(copia.duplicatedFromId).toBe(original.postId);
    expect(copia.contentId).not.toBe(cenario.contentId);

    const novoConteudo = await prisma.content.findUniqueOrThrow({
      where: { id: copia.contentId },
      include: { media: true, variants: true },
    });

    expect(novoConteudo.title).toBe('Título original');
    expect(novoConteudo.body).toBe('Corpo original.');
    expect(novoConteudo.hashtags).toEqual(['original']);
    expect(novoConteudo.media).toHaveLength(1);
    expect(novoConteudo.variants).toHaveLength(1);
    expect(novoConteudo.variants[0]?.body).toBe('Corpo do YouTube.');

    // A mídia é reaproveitada por REFERÊNCIA: o arquivo no storage é
    // imutável, duplicá-lo só gastaria espaço.
    const conteudoOriginal = await prisma.content.findUniqueOrThrow({
      where: { id: cenario.contentId },
      include: { media: true },
    });
    expect(novoConteudo.media[0]?.mediaAssetId).toBe(conteudoOriginal.media[0]?.mediaAssetId);

    const post = await prisma.post.findUniqueOrThrow({ where: { id: copia.postId } });
    expect(post.duplicatedFromId).toBe(original.postId);
    expect(post.contentId).toBe(copia.contentId);
  });

  it('editar a cópia NÃO reescreve o texto do post original', async () => {
    // É a razão inteira de copiar em vez de referenciar.
    const cenario = await criarCenario({ contas: 1 });
    const service = new PostService(container());

    const original = await service.create(
      cenario.auth,
      { contentId: cenario.contentId, selection: { groupIds: [cenario.groupId] } },
      'teste',
    );
    const copia = await service.duplicate(cenario.auth, original.postId, {}, 'teste');

    await prisma.content.update({
      where: { id: copia.contentId },
      data: { body: 'Texto reescrito para a republicação.' },
    });

    const conteudoOriginal = await prisma.content.findUniqueOrThrow({
      where: { id: cenario.contentId },
    });
    expect(conteudoOriginal.body).toBe('Corpo original.');
  });

  it('os destinos vêm dos destinos da origem, não de uma reexpansão do grupo', async () => {
    // Mudança de grupo NUNCA altera agendamento sozinha (SPEC seção 6.1).
    // Se a duplicação reexpandisse o grupo, a cópia herdaria uma conta que
    // entrou depois — exatamente a alteração silenciosa que a regra proíbe.
    const cenario = await criarCenario({ contas: 2 });
    const service = new PostService(container());

    const original = await service.create(
      cenario.auth,
      { contentId: cenario.contentId, selection: { groupIds: [cenario.groupId] } },
      'teste',
    );

    const novaConta = await prisma.socialAccount.create({
      data: {
        organizationId: cenario.organizationId,
        clientId: cenario.clientId,
        platform: 'YOUTUBE',
        remoteId: `canal-novo-${randomUUID().slice(0, 6)}`,
        nickname: 'Canal que entrou depois',
        remoteDisplayName: 'Canal que entrou depois',
        timezone: 'America/Sao_Paulo',
        status: 'ACTIVE',
      },
    });

    await prisma.accountGroupMember.create({
      data: {
        organizationId: cenario.organizationId,
        accountGroupId: cenario.groupId,
        socialAccountId: novaConta.id,
      },
    });

    const copia = await service.duplicate(cenario.auth, original.postId, {}, 'teste');

    const destinos = await prisma.postTarget.findMany({
      where: { postId: copia.postId },
      select: { socialAccountId: true },
    });

    expect(destinos).toHaveLength(2);
    expect(destinos.map((destino) => destino.socialAccountId).sort()).toEqual(
      [...cenario.accountIds].sort(),
    );
    expect(destinos.some((destino) => destino.socialAccountId === novaConta.id)).toBe(false);
  });

  it('seleção explícita substitui os destinos da origem', async () => {
    const cenario = await criarCenario({ contas: 3 });
    const service = new PostService(container());

    const original = await service.create(
      cenario.auth,
      { contentId: cenario.contentId, selection: { groupIds: [cenario.groupId] } },
      'teste',
    );

    const escolhida = cenario.accountIds[2]!;
    const copia = await service.duplicate(
      cenario.auth,
      original.postId,
      { selection: { accountIds: [escolhida] } },
      'teste',
    );

    const destinos = await prisma.postTarget.findMany({
      where: { postId: copia.postId },
      select: { socialAccountId: true },
    });

    expect(destinos).toHaveLength(1);
    expect(destinos[0]?.socialAccountId).toBe(escolhida);
  });

  it('reuseContent aponta para o MESMO conteúdo, sem copiar', async () => {
    const cenario = await criarCenario({ contas: 1 });
    const service = new PostService(container());

    const original = await service.create(
      cenario.auth,
      { contentId: cenario.contentId, selection: { groupIds: [cenario.groupId] } },
      'teste',
    );

    const copia = await service.duplicate(
      cenario.auth,
      original.postId,
      { reuseContent: true },
      'teste',
    );

    expect(copia.contentId).toBe(cenario.contentId);
    await expect(prisma.content.count()).resolves.toBe(1);
  });

  it('registra a duplicação na auditoria', async () => {
    const cenario = await criarCenario({ contas: 1 });
    const service = new PostService(container());

    const original = await service.create(
      cenario.auth,
      { contentId: cenario.contentId, selection: { groupIds: [cenario.groupId] } },
      'teste',
    );
    const copia = await service.duplicate(cenario.auth, original.postId, {}, 'teste');

    const registro = await prisma.auditLog.findFirst({
      where: { action: 'post.duplicate', entityId: copia.postId },
    });

    expect(registro).not.toBeNull();
    expect((registro?.changes as { origem?: string } | null)?.origem).toBe(original.postId);
  });

  it('publicação de outra organização não é encontrada', async () => {
    const a = await criarCenario({ contas: 1 });
    const b = await criarCenario({ contas: 1 });
    const service = new PostService(container());

    const original = await service.create(
      a.auth,
      { contentId: a.contentId, selection: { groupIds: [a.groupId] } },
      'teste',
    );

    await expect(service.duplicate(b.auth, original.postId, {}, 'teste')).rejects.toThrow(
      /Publicação/i,
    );
  });
});
