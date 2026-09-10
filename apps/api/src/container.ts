import {
  QUEUE_NAMES,
  hasCredentials,
  listPlatformDefinitions,
  type AdapterRegistry,
  type PlatformKey,
  type SocialMediaAdapter,
} from '@app/core';
import { getPrismaClient, type PrismaClient } from '@app/db';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { createYouTubeAdapter } from './adapters/youtube/index.js';
import type { Env } from './config/env.js';
import { buildKeyring, type EncryptionKeyring } from './lib/crypto.js';
import { createLogger, type Logger } from './lib/logger.js';
import { createMailer, type Mailer } from './lib/mailer.js';
import { S3StorageProvider, type StorageProvider } from './lib/storage.js';

/**
 * Composição das dependências.
 *
 * Injeção explícita em vez de container mágico: as dependências de cada
 * módulo ficam visíveis na assinatura, e um teste monta o container com um
 * Prisma de teste sem precisar de framework de mock.
 */

export interface Container {
  env: Env;
  logger: Logger;
  prisma: PrismaClient;
  redis: Redis;
  storage: StorageProvider;
  mailer: Mailer;
  keyring: EncryptionKeyring;
  queues: Queues;
  adapters: AdapterRegistry;
  /** Plataformas com credenciais de app preenchidas NESTE ambiente. */
  configuredPlatforms: Set<PlatformKey>;
}

export interface Queues {
  publish: Queue;
  mediaProcessing: Queue;
  tokenRefresh: Queue;
  analyticsCollection: Queue;
  inboxSync: Queue;
  notifications: Queue;
  reports: Queue;
  maintenance: Queue;
}

export function createContainer(env: Env): Container {
  const logger = createLogger({
    level: env.LOG_LEVEL,
    pretty: env.NODE_ENV === 'development',
    serviceName: env.OTEL_SERVICE_NAME,
  });

  const prisma = getPrismaClient({
    databaseUrl: env.DATABASE_URL,
    logQueries: env.LOG_LEVEL === 'trace',
  });

  // maxRetriesPerRequest: null é exigido pelo BullMQ — com retry finito, um
  // blocking pop cancelado derruba o worker em vez de reconectar.
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

  const storage = new S3StorageProvider({
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKey: env.S3_ACCESS_KEY,
    secretKey: env.S3_SECRET_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
  });

  const mailer = createMailer({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    from: env.MAIL_FROM,
    ...(env.SMTP_USER ? { user: env.SMTP_USER } : {}),
    ...(env.SMTP_PASSWORD ? { password: env.SMTP_PASSWORD } : {}),
  });

  const keyring = buildKeyring(env.ENCRYPTION_KEY);

  const queues = createQueues(env, redis);
  const { adapters, configuredPlatforms } = createAdapterRegistry(env);

  return {
    env,
    logger,
    prisma,
    redis,
    storage,
    mailer,
    keyring,
    queues,
    adapters,
    configuredPlatforms,
  };
}

function createQueues(env: Env, connection: Redis): Queues {
  const make = (name: string): Queue =>
    new Queue(name, {
      connection,
      prefix: env.QUEUE_PREFIX,
      defaultJobOptions: {
        // Jobs concluídos somem em 24h; falhos ficam 30 dias para
        // diagnóstico. Sem limite, o Redis cresce indefinidamente.
        removeOnComplete: { age: 86_400, count: 5_000 },
        removeOnFail: { age: 2_592_000 },
      },
    });

  return {
    publish: make(QUEUE_NAMES.publish),
    mediaProcessing: make(QUEUE_NAMES.mediaProcessing),
    tokenRefresh: make(QUEUE_NAMES.tokenRefresh),
    analyticsCollection: make(QUEUE_NAMES.analyticsCollection),
    inboxSync: make(QUEUE_NAMES.inboxSync),
    notifications: make(QUEUE_NAMES.notifications),
    reports: make(QUEUE_NAMES.reports),
    maintenance: make(QUEUE_NAMES.maintenance),
  };
}

/**
 * Registro de adapters.
 *
 * Só entra no registro a plataforma que TEM implementação. Uma rede
 * declarada mas não implementada não ganha um adapter vazio que finge
 * publicar — quem pedir recebe erro explícito (SPEC seção 19).
 */
export function createAdapterRegistry(env: Env): {
  adapters: AdapterRegistry;
  configuredPlatforms: Set<PlatformKey>;
} {
  const implemented = new Map<PlatformKey, SocialMediaAdapter>();

  implemented.set('YOUTUBE', createYouTubeAdapter());

  const configuredPlatforms = new Set<PlatformKey>();
  for (const def of listPlatformDefinitions()) {
    if (def.isAvailable && hasCredentials(def, env as unknown as NodeJS.ProcessEnv)) {
      configuredPlatforms.add(def.key);
    }
  }

  const adapters: AdapterRegistry = {
    get(platform) {
      const adapter = implemented.get(platform);
      if (!adapter) {
        throw new Error(
          `Não há adapter implementado para ${platform}. ` +
            `Esta rede aparece como indisponível na interface.`,
        );
      }
      return adapter;
    },
    has: (platform) => implemented.has(platform),
    list: () => [...implemented.values()],
  };

  return { adapters, configuredPlatforms };
}

export async function closeContainer(container: Container): Promise<void> {
  await Promise.allSettled([
    ...Object.values(container.queues).map((queue) => queue.close()),
    container.prisma.$disconnect(),
    container.redis.quit(),
  ]);
}
