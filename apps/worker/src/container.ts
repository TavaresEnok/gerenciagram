import { getPrismaClient, type PrismaClient } from '@app/db';
import {
  buildKeyring,
  createCircuitGuard,
  createCircuitStore,
  createPlatformServices,
  type CircuitGuard,
  type EncryptionKeyring,
  type PlatformServices,
} from '@app/platform';
import { Redis } from 'ioredis';
import { pino, type Logger } from 'pino';
import { loadWorkerEnv, type WorkerEnv } from './config/env.js';
import { createMailer, type Mailer } from './lib/mailer.js';
import { S3Storage, type Storage } from './lib/storage.js';

/**
 * Dependências do worker.
 *
 * Compartilha `@app/platform` com a API de propósito: adapter, renovação de
 * token, cota e circuit breaker precisam ser exatamente os mesmos nos dois
 * processos. Se divergissem, o worker publicaria sob uma regra que a API não
 * aplicou no agendamento.
 */

export interface WorkerContainer {
  env: WorkerEnv;
  logger: Logger;
  prisma: PrismaClient;
  redis: Redis;
  storage: Storage;
  mailer: Mailer;
  keyring: EncryptionKeyring;
  platforms: PlatformServices;
  circuit: CircuitGuard;
}

export function createWorkerContainer(): WorkerContainer {
  const env = loadWorkerEnv();

  const logger = pino({
    level: env.LOG_LEVEL,
    base: { service: 'gerenciador-worker' },
    redact: {
      paths: [
        '*.accessToken',
        '*.refreshToken',
        '*.accessTokenEnc',
        '*.refreshTokenEnc',
        'credentials.accessToken',
        'credentials.refreshToken',
      ],
      censor: '[REDIGIDO]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(env.NODE_ENV === 'development'
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service' },
          },
        }
      : {}),
  });

  const prisma = getPrismaClient({ databaseUrl: env.DATABASE_URL });
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

  const storage = new S3Storage({
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
  });

  const platforms = createPlatformServices(env);
  const circuit = createCircuitGuard(createCircuitStore(prisma));

  return {
    env,
    logger,
    prisma,
    redis,
    storage,
    mailer,
    keyring: buildKeyring(env.ENCRYPTION_KEY, {
      currentVersion: env.ENCRYPTION_KEY_VERSION,
      previousKeys: env.ENCRYPTION_KEYS_PREVIOUS,
    }),
    platforms,
    circuit,
  };
}

export async function closeWorkerContainer(container: WorkerContainer): Promise<void> {
  await Promise.allSettled([container.prisma.$disconnect(), container.redis.quit()]);
}
