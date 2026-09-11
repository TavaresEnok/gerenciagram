import { randomUUID } from 'node:crypto';
import {
  buildTargetIdempotencyKey,
  getPlatformDefinition,
  type AdapterRegistry,
  type AppCredentials,
  type PlatformKey,
  type PublishResult,
  type SocialMediaAdapter,
} from '@app/core';
import { PrismaClient } from '@app/db';
import { buildKeyring, createCircuitGuard, createCircuitStore, encrypt } from '@app/platform';
import type { Job } from 'bullmq';
import { pino } from 'pino';
import type { WorkerContainer } from '../container.js';

/**
 * Infraestrutura dos testes do worker.
 *
 * O ÚNICO ponto substituído é o adapter da plataforma — porque não dá para
 * publicar de verdade no YouTube num teste automatizado. Banco, cota, circuit
 * breaker, criptografia e a lógica do processador são os reais: é neles que
 * moram as garantias que a SPEC seção 21 manda provar.
 */

export interface FakePublisherBehavior {
  /** Fila de respostas; cada chamada consome a próxima. */
  responses: Array<PublishResult | Error>;
  /** Chamadas efetivamente feitas — o contador de publicação duplicada. */
  calls: Array<{ idempotencyKey: string; title?: string | undefined; body: string }>;
}

export function createFakeAdapter(
  platform: PlatformKey,
  behavior: FakePublisherBehavior,
): SocialMediaAdapter {
  const notImplemented = () => {
    throw new Error('não usado neste teste');
  };

  return {
    platform,
    definition: getPlatformDefinition(platform),
    auth: {
      buildAuthorizationUrl: () => 'https://exemplo.invalid/auth',
      exchangeCodeForTokens: notImplemented as never,
      refreshCredentials: async (_app: AppCredentials, credentials) => credentials,
      revoke: async () => undefined,
      fetchIdentity: async () => ({ remoteId: 'canal-de-teste' }),
    },
    publisher: {
      async publish(_credentials, input) {
        behavior.calls.push({
          idempotencyKey: input.idempotencyKey,
          title: input.title,
          body: input.body,
        });

        const next = behavior.responses.shift();
        if (!next) throw new Error('nenhuma resposta configurada para esta chamada');
        if (next instanceof Error) throw next;
        return next;
      },
      fetchRemoteState: async (_c, remoteId) => ({ remoteId, status: 'READY' as const }),
      deletePost: async () => undefined,
      fetchDynamicFieldOptions: async () => [],
    },
  };
}

export interface TestHarness {
  container: WorkerContainer;
  prisma: PrismaClient;
  behavior: FakePublisherBehavior;
  cleanup: () => Promise<void>;
}

export async function createHarness(platform: PlatformKey = 'YOUTUBE'): Promise<TestHarness> {
  const prisma = new PrismaClient({
    datasources: { db: { url: process.env['DATABASE_URL_TEST'] as string } },
    log: ['warn', 'error'],
  });

  const behavior: FakePublisherBehavior = { responses: [], calls: [] };
  const adapter = createFakeAdapter(platform, behavior);

  const adapters: AdapterRegistry = {
    get: () => adapter,
    has: () => true,
    list: () => [adapter],
  };

  const keyring = buildKeyring(Buffer.alloc(32, 7).toString('base64'));

  const container: WorkerContainer = {
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      DATABASE_URL: process.env['DATABASE_URL_TEST'] as string,
      REDIS_URL: process.env['REDIS_URL'] ?? 'redis://localhost:6380',
      QUEUE_PREFIX: 'grs-test',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'teste',
      S3_ACCESS_KEY: 'teste',
      S3_SECRET_KEY: 'teste',
      S3_FORCE_PATH_STYLE: true,
      ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      SMTP_HOST: 'localhost',
      SMTP_PORT: 1025,
      SMTP_SECURE: false,
      MAIL_FROM: 'teste@localhost',
      WEB_PUBLIC_URL: 'http://localhost:3000',
      OAUTH_PUBLIC_URL: 'http://localhost:3001',
      FFMPEG_PATH: 'ffmpeg',
      FFPROBE_PATH: 'ffprobe',
      PUBLISH_CONCURRENCY: 5,
      MEDIA_CONCURRENCY: 2,
      YOUTUBE_CLIENT_ID: 'teste',
      YOUTUBE_CLIENT_SECRET: 'teste',
    } as WorkerContainer['env'],
    logger: pino({ level: 'silent' }),
    prisma,
    redis: null as never,
    storage: {
      // Nenhum teste aqui sobe arquivo de verdade; o adapter falso não lê o
      // stream. Um teste que precisasse do conteúdo usaria o MinIO real.
      getObjectStream: async () => {
        const { Readable } = await import('node:stream');
        return Readable.from([Buffer.from('conteudo-de-teste')]);
      },
      getObjectBuffer: async () => Buffer.from('conteudo-de-teste'),
      putObject: async () => undefined,
      // URL fixa e claramente falsa: nenhum teste aqui chega a buscá-la, e um
      // endereço que parecesse real esconderia um teste que a usasse por engano.
      getSignedDownloadUrl: async (key: string) =>
        `https://storage.invalid/${encodeURIComponent(key)}?assinatura=teste`,
    },
    mailer: { send: async () => undefined },
    keyring,
    platforms: {
      adapters,
      configuredPlatforms: new Set<PlatformKey>([platform]),
      appCredentials: () => ({
        clientId: 'teste',
        clientSecret: 'teste',
        redirectUri: 'http://localhost:3001/v1/oauth/youtube/callback',
      }),
    },
    circuit: createCircuitGuard(createCircuitStore(prisma)),
  };

  await resetDatabase(prisma);
  await seedPlatform(prisma, platform);

  return {
    container,
    prisma,
    behavior,
    cleanup: async () => {
      await prisma.$disconnect();
    },
  };
}

async function resetDatabase(prisma: PrismaClient): Promise<void> {
  // TRUNCATE em vez de deleteMany: mais rápido e resolve as dependências de
  // chave estrangeira de uma vez.
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      publish_attempts, post_targets, posts, content_variants, content_media,
      contents, media_assets, media_folders, account_group_members,
      account_groups, posting_schedules, oauth_tokens, social_accounts,
      clients, memberships, sessions, users, organizations,
      platform_quota_usage, analytics_snapshots, dead_letter_jobs,
      notifications, audit_logs
    RESTART IDENTITY CASCADE
  `);

  await prisma.socialPlatform.updateMany({
    data: {
      circuitState: 'CLOSED',
      circuitFailureCount: 0,
      circuitOpenedAt: null,
      circuitHalfOpenAt: null,
    },
  });
}

async function seedPlatform(prisma: PrismaClient, platform: PlatformKey): Promise<void> {
  const definition = getPlatformDefinition(platform);

  await prisma.socialPlatform.upsert({
    where: { key: platform },
    create: {
      key: platform,
      displayName: definition.displayName,
      isAvailable: true,
      capabilities: definition.capabilities as never,
      mediaRequirements: definition.mediaRequirements as never,
      quotaRules: definition.quotaRules as never,
      duplicateContentPolicy: definition.duplicateContentPolicy as never,
      requiredUxFields: definition.requiredUxFields as never,
      oauthScopes: definition.oauthScopes,
      credentialsConfigured: true,
    },
    update: { isAvailable: true, credentialsConfigured: true },
  });
}

// ---------------------------------------------------------------------------
//  Fixtures
// ---------------------------------------------------------------------------

export interface Scenario {
  organizationId: string;
  clientId: string;
  userId: string;
  contentId: string;
  postId: string;
  /** Um destino por conta, na ordem em que as contas foram criadas. */
  targets: Array<{ id: string; accountId: string; nickname: string }>;
}

/**
 * Monta o cenário de referência da SPEC seção 6.1: uma publicação para N
 * contas da mesma rede, cada uma com seu destino.
 */
export async function createScenario(
  prisma: PrismaClient,
  options: {
    accountCount: number;
    platform?: PlatformKey;
    timezone?: string;
    scheduledAt?: Date;
    body?: string;
  },
): Promise<Scenario> {
  const platform = options.platform ?? 'YOUTUBE';
  const timezone = options.timezone ?? 'America/Sao_Paulo';

  const organization = await prisma.organization.create({
    data: { name: 'Organização de teste', slug: `org-${randomUUID().slice(0, 8)}`, timezone },
  });

  const user = await prisma.user.create({
    data: { email: `teste-${randomUUID().slice(0, 8)}@exemplo.invalid`, name: 'Teste' },
  });

  await prisma.membership.create({
    data: { organizationId: organization.id, userId: user.id, role: 'OWNER' },
  });

  const client = await prisma.client.create({
    data: { organizationId: organization.id, name: 'Cliente', slug: 'cliente', timezone },
  });

  const accounts = [];
  for (let index = 0; index < options.accountCount; index += 1) {
    const account = await prisma.socialAccount.create({
      data: {
        organizationId: organization.id,
        clientId: client.id,
        platform,
        remoteId: `canal-${index}`,
        nickname: `Canal ${index + 1}`,
        remoteDisplayName: `Canal ${index + 1}`,
        timezone,
        status: 'ACTIVE',
      },
    });

    const encrypted = encrypt('token-de-teste', buildKeyring(Buffer.alloc(32, 7).toString('base64')));
    await prisma.oAuthToken.create({
      data: {
        socialAccountId: account.id,
        organizationId: organization.id,
        accessTokenEnc: encrypted.ciphertext,
        keyVersion: encrypted.keyVersion,
        scopes: ['https://www.googleapis.com/auth/youtube.upload'],
        // Bem no futuro: os testes não devem disparar renovação de token.
        accessTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
      },
    });

    accounts.push(account);
  }

  const content = await prisma.content.create({
    data: {
      organizationId: organization.id,
      clientId: client.id,
      createdById: user.id,
      title: 'Título de teste',
      body: options.body ?? 'Corpo do conteúdo de teste.',
      hashtags: ['teste'],
    },
  });

  const post = await prisma.post.create({
    data: {
      organizationId: organization.id,
      clientId: client.id,
      contentId: content.id,
      createdById: user.id,
      status: 'SCHEDULED',
      intendedScheduledAt: options.scheduledAt ?? new Date(),
    },
  });

  const targets = [];
  for (const account of accounts) {
    const target = await prisma.postTarget.create({
      data: {
        organizationId: organization.id,
        postId: post.id,
        socialAccountId: account.id,
        platform,
        status: 'SCHEDULED',
        scheduledAt: options.scheduledAt ?? new Date(),
        scheduledTimezone: timezone,
        idempotencyKey: buildTargetIdempotencyKey(post.id, account.id),
      },
    });

    targets.push({ id: target.id, accountId: account.id, nickname: account.nickname });
  }

  return {
    organizationId: organization.id,
    clientId: client.id,
    userId: user.id,
    contentId: content.id,
    postId: post.id,
    targets,
  };
}

/** Job do BullMQ o suficiente para o processador funcionar. */
export function fakeJob(postTargetId: string, organizationId: string): Job {
  let delay = 0;

  return {
    id: `publish:${postTargetId}`,
    name: 'publish-target',
    data: {
      postTargetId,
      organizationId,
      platform: 'YOUTUBE',
      idempotencyKey: 'chave',
      correlationId: `teste-${randomUUID().slice(0, 8)}`,
    },
    attemptsMade: 0,
    opts: { attempts: 5 },
    changeDelay: async (value: number) => {
      delay = value;
    },
    getDelay: () => delay,
  } as unknown as Job;
}
