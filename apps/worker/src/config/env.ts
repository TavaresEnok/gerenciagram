import { z } from 'zod';

/**
 * Configuração do worker.
 *
 * Compartilha o mesmo `.env` da API — inclusive as credenciais de plataforma,
 * porque é o worker quem realmente chama a API externa. Manter dois arquivos
 * de ambiente seria o caminho mais curto para a API validar contra uma cota e
 * o worker publicar contra outra.
 */

const envBoolean = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .default(defaultValue)
    .transform((value) =>
      typeof value === 'boolean'
        ? value
        : ['1', 'true', 'yes', 'on', 'sim'].includes(value.trim().toLowerCase()),
    );

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  QUEUE_PREFIX: z.string().default('grs'),

  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: envBoolean(true),

  ENCRYPTION_KEY: z
    .string()
    .refine((value) => Buffer.from(value, 'base64').length === 32, {
      message: 'precisa ser 32 bytes em base64',
    }),

  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_SECURE: envBoolean(false),
  MAIL_FROM: z.string().default('Gerenciador <nao-responda@localhost>'),

  WEB_PUBLIC_URL: z.string().default('http://localhost:3000'),
  OAUTH_PUBLIC_URL: z.string().default('http://localhost:3001'),

  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),

  /** Quantos jobs de publicação em paralelo por processo. */
  PUBLISH_CONCURRENCY: z.coerce.number().int().positive().default(5),
  MEDIA_CONCURRENCY: z.coerce.number().int().positive().default(2),

  YOUTUBE_CLIENT_ID: z.string().optional(),
  YOUTUBE_CLIENT_SECRET: z.string().optional(),
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  // Token do desafio de subscrição de webhook, cadastrado no console da Meta.
  // Sem ele o verificador não é montado e o endpoint responde 501.
  META_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  TIKTOK_CLIENT_KEY: z.string().optional(),
  TIKTOK_CLIENT_SECRET: z.string().optional(),
  X_CLIENT_ID: z.string().optional(),
  X_CLIENT_SECRET: z.string().optional(),
  KWAI_CLIENT_ID: z.string().optional(),
  KWAI_CLIENT_SECRET: z.string().optional(),
});

export type WorkerEnv = z.infer<typeof schema>;

export function loadWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const parsed = schema.safeParse(source);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuração inválida do worker:\n${issues}`);
  }

  return parsed.data;
}
