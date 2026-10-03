import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@app/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Container } from '../../container.js';
import { registerHumanReview } from '../../lib/ai-review.js';
import type { AuthContext } from '../../plugins/auth.js';
import { ContentService } from './service.js';

/**
 * Proveniência e revisão de conteúdo de IA (SPEC seção 6), ponta a ponta no
 * nível dos serviços da API, contra Postgres real.
 *
 * O que esta suíte prova sobre os defeitos da revisão:
 *
 *  1. Criar conteúdo SEM o campo não pode marcá-lo como de IA por engano, e
 *     criar COM o campo nasce exigindo revisão.
 *  2. Um PATCH NUNCA confirma revisão (o comportamento anterior marcava
 *     `aiReviewedAt` sozinho na primeira edição — exatamente o que a SPEC
 *     proíbe, porque autosave não é leitura humana).
 *  3. A revisão é uma ação explícita, vinculada ao hash da versão revisada.
 *  4. Editar texto, hashtags, mídia ou variação DEPOIS da revisão exige
 *     revisar de novo — mas reenviar a MESMA variação (o compositor faz isso
 *     a cada preview) não invalida nada.
 */

const prisma = new PrismaClient({
  datasources: { db: { url: process.env['DATABASE_URL_TEST'] as string } },
  log: ['warn', 'error'],
});

afterAll(async () => {
  await prisma.$disconnect();
});

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
  userId: string;
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
});

async function criarFixture(): Promise<Fixture> {
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

  return {
    auth: {
      userId: user.id,
      organizationId: organization.id,
      role: 'OWNER',
      scopedClientIds: [],
      mfaSatisfied: true,
    },
    organizationId: organization.id,
    userId: user.id,
  };
}

describe('cadeia completa: gerar → aplicar → salvar → bloquear → revisar → permitir → modificar → exigir de novo', () => {
  it('percorre o ciclo inteiro de revisão', async () => {
    const { auth, organizationId } = await criarFixture();
    const service = new ContentService(container());

    // 1) "Gerar sugestão → aplicar → salvar": a tela marca aiGenerated=true.
    const criado = await service.create(
      auth,
      { body: 'Legenda sugerida pela IA.', aiGenerated: true },
      'teste',
    );
    expect(criado.aiGenerated).toBe(true);
    expect(criado.aiReviewedAt).toBeNull();

    // 2) Um PATCH qualquer NÃO confirma revisão (regressão do comportamento
    //    anterior, que marcava aiReviewedAt na primeira edição).
    const editado = await service.update(
      auth,
      criado.id,
      { body: 'Legenda sugerida pela IA, revisada?' },
      'teste',
    );
    expect(editado.aiReviewedAt).toBeNull();

    // 3) Revisão é ação explícita: registra e vincula a versão.
    await service.update(auth, criado.id, { body: 'Legenda final, lida por uma pessoa.' }, 'teste');
    const revisao = await registerHumanReview(prisma, {
      contentId: criado.id,
      organizationId,
    });
    expect(revisao.reviewedAt).toBeInstanceOf(Date);

    const revisado = await service.get(auth, criado.id);
    expect(revisado.aiReviewedAt).not.toBeNull();

    const registro = await prisma.content.findUniqueOrThrow({ where: { id: criado.id } });
    expect(registro.aiReviewHash).toMatch(/^[0-9a-f]{64}$/);

    // 4) Modificar o conteúdo DEPOIS da aprovação exige nova revisão.
    const modificado = await service.update(auth, criado.id, { body: 'Texto alterado.' }, 'teste');
    expect(modificado.aiReviewedAt).toBeNull();
  });

  it('criar sem o campo NÃO marca como IA (o texto pode ter sido digitado)', async () => {
    const { auth } = await criarFixture();
    const service = new ContentService(container());

    const criado = await service.create(auth, { body: 'Escrito à mão.' }, 'teste');
    expect(criado.aiGenerated).toBe(false);
    expect(criado.aiReviewedAt).toBeNull();
  });

  it('aplicar sugestão de IA num conteúdo humano o transforma em conteúdo de IA', async () => {
    const { auth } = await criarFixture();
    const service = new ContentService(container());

    const criado = await service.create(auth, { body: 'Escrito à mão.' }, 'teste');
    const aplicado = await service.update(
      auth,
      criado.id,
      { body: 'Versão sugerida pela IA.', aiGenerated: true },
      'teste',
    );

    expect(aplicado.aiGenerated).toBe(true);
    expect(aplicado.aiReviewedAt).toBeNull();
  });

  it('revisão de conteúdo humano é recusada — não há o que revisar', async () => {
    const { auth, organizationId } = await criarFixture();
    const service = new ContentService(container());

    const criado = await service.create(auth, { body: 'Escrito à mão.' }, 'teste');

    await expect(
      registerHumanReview(prisma, { contentId: criado.id, organizationId }),
    ).rejects.toThrow(/não foi gerado por IA/i);
  });
});

describe('variações por rede/conta também protegem a revisão', () => {
  it('mudar a variação depois da revisão a invalida; reenviar a mesma, não', async () => {
    const { auth, organizationId } = await criarFixture();
    const service = new ContentService(container());

    const cliente = await prisma.client.create({
      data: {
        organizationId,
        name: 'Cliente',
        slug: `cliente-${randomUUID().slice(0, 8)}`,
        timezone: 'America/Sao_Paulo',
      },
    });

    const conta = await prisma.socialAccount.create({
      data: {
        organizationId,
        clientId: cliente.id,
        platform: 'YOUTUBE',
        remoteId: `canal-${randomUUID().slice(0, 6)}`,
        nickname: 'Canal 1',
        remoteDisplayName: 'Canal 1',
        timezone: 'America/Sao_Paulo',
        status: 'ACTIVE',
      },
    });

    const criado = await service.create(
      auth,
      { body: 'Legenda base de IA.', aiGenerated: true },
      'teste',
    );

    const variantes = [
      {
        platform: 'YOUTUBE' as const,
        socialAccountId: conta.id,
        title: 'Título do vídeo',
        body: 'Corpo do vídeo.',
        platformFields: { privacyStatus: 'public' },
      },
    ];

    await service.setVariants(auth, criado.id, variantes, 'teste');
    await registerHumanReview(prisma, { contentId: criado.id, organizationId });

    // O compositor reenvia as mesmas variações a cada preview: idêntico não
    // pode derrubar a revisão, senão ela seria impossível de manter.
    const reenviado = await service.setVariants(auth, criado.id, variantes, 'teste');
    expect(reenviado.aiReviewedAt).not.toBeNull();

    // Mudar o override da conta DEPOIS de revisar exige revisar de novo.
    const alterado = await service.setVariants(
      auth,
      criado.id,
      [{ ...variantes[0]!, body: 'Outro corpo, não revisado.' }],
      'teste',
    );
    expect(alterado.aiReviewedAt).toBeNull();
  });

  it('trocar a mídia de um conteúdo de IA revisado exige nova revisão', async () => {
    const { auth, organizationId } = await criarFixture();
    const service = new ContentService(container());

    const midia = await prisma.mediaAsset.create({
      data: {
        organizationId,
        filename: 'video.mp4',
        originalFilename: 'video.mp4',
        mimeType: 'video/mp4',
        type: 'VIDEO',
        sizeBytes: BigInt(5_000_000),
        storageKey: `org/${organizationId}/${randomUUID()}.mp4`,
        checksum: randomUUID().replace(/-/g, ''),
        processingStatus: 'READY',
      },
    });

    const criado = await service.create(
      auth,
      { body: 'Legenda de IA.', aiGenerated: true },
      'teste',
    );
    await registerHumanReview(prisma, { contentId: criado.id, organizationId });

    const trocado = await service.update(auth, criado.id, { mediaAssetIds: [midia.id] }, 'teste');
    expect(trocado.aiReviewedAt).toBeNull();
  });
});
