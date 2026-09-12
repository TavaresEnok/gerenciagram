import { parsePreviousKeys } from '@app/platform';
import { z } from 'zod';

/**
 * Configuração validada na subida.
 *
 * O processo se recusa a iniciar com configuração inválida em vez de quebrar
 * na primeira requisição. Segredos criptográficos têm tamanho mínimo
 * verificado aqui — uma ENCRYPTION_KEY curta só apareceria como erro na hora
 * de cifrar o primeiro token OAuth, muito depois do deploy.
 */

const base64Key32 = z
  .string()
  .min(1, 'obrigatória')
  .refine(
    (value) => {
      try {
        return Buffer.from(value, 'base64').length === 32;
      } catch {
        return false;
      }
    },
    { message: 'precisa ser 32 bytes em base64 (gere com: openssl rand -base64 32)' },
  );

const previousKeys = z
  .string()
  .optional()
  .transform((value, ctx): Record<number, string> => {
    // A interpretação vive em @app/platform: API e worker PRECISAM ler isto
    // de forma idêntica, senão um cifra numa versão e o outro não decifra.
    try {
      return parsePreviousKeys(value);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  });


/**
 * Booleano vindo de variável de ambiente.
 *
 * NÃO use z.coerce.boolean() aqui: ele aplica a regra de truthiness do
 * JavaScript, e a string "false" é truthy — ou seja, SMTP_SECURE=false viraria
 * true e a conexão tentaria TLS numa porta em texto claro. Este parser lê o
 * valor como texto e compara explicitamente.
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

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().positive().default(3001),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  QUEUE_PREFIX: z.string().default('grs'),

  // Storage
  STORAGE_DRIVER: z.enum(['s3', 'local']).default('s3'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: envBoolean(true),
  S3_PUBLIC_URL: z.string().optional(),

  // Segurança
  JWT_ACCESS_SECRET: z.string().min(32, 'use pelo menos 32 caracteres'),
  JWT_REFRESH_SECRET: z.string().min(32, 'use pelo menos 32 caracteres'),
  ENCRYPTION_KEY: base64Key32,
  /**
   * Versão da chave atual. Ao rotacionar, incremente e mova a anterior para
   * ENCRYPTION_KEYS_PREVIOUS — sem isso, a chave nova ocupa o slot da antiga
   * e todo token OAuth já gravado deixa de decifrar.
   */
  ENCRYPTION_KEY_VERSION: z.coerce.number().int().min(1).default(1),
  /** Chaves anteriores em JSON, por versão: {"1":"<base64 de 32 bytes>"} */
  ENCRYPTION_KEYS_PREVIOUS: previousKeys,
  ACCESS_TOKEN_TTL: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL: z.coerce.number().int().positive().default(2_592_000),
  COOKIE_DOMAIN: z.string().default('localhost'),
  COOKIE_SECURE: envBoolean(false),
  TOTP_ISSUER: z.string().default('Gerenciador de Redes Sociais'),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW: z.coerce.number().int().positive().default(60_000),

  // URLs
  API_PUBLIC_URL: z.string().default('http://localhost:3001'),
  WEB_PUBLIC_URL: z.string().default('http://localhost:3000'),
  OAUTH_PUBLIC_URL: z.string().default('http://localhost:3001'),

  // E-mail
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_SECURE: envBoolean(false),
  MAIL_FROM: z.string().default('Gerenciador <nao-responda@localhost>'),

  // Observabilidade
  SENTRY_DSN: z.string().optional(),
  OTEL_SERVICE_NAME: z.string().default('gerenciador-api'),

  // Mídia
  MEDIA_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(524_288_000),

  // Credenciais de plataforma — todas OPCIONAIS de propósito.
  // Ausência significa "não configurada", e a UI mostra isso. O sistema
  // nunca substitui uma credencial faltante por um mock (SPEC seção 19).
  YOUTUBE_CLIENT_ID: z.string().optional(),
  YOUTUBE_CLIENT_SECRET: z.string().optional(),
  YOUTUBE_PROJECT_DAILY_QUOTA: z.coerce.number().int().positive().default(100),
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  // Token do desafio de subscrição de webhook, cadastrado no console da Meta.
  // Sem ele o verificador não é montado e o endpoint responde 501.
  META_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  META_API_VERSION: z.string().default('v21.0'),
  TIKTOK_CLIENT_KEY: z.string().optional(),
  TIKTOK_CLIENT_SECRET: z.string().optional(),
  X_CLIENT_ID: z.string().optional(),
  X_CLIENT_SECRET: z.string().optional(),
  KWAI_CLIENT_ID: z.string().optional(),
  KWAI_CLIENT_SECRET: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  AI_BASE_URL: z.string().optional(),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('gemini-2.0-flash'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Configuração inválida. Corrija o .env (use .env.example como referência):\n${issues}`,
    );
  }

  return parsed.data;
}

export function getEnv(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Só para testes: descarta o cache entre casos. */
export function resetEnvCache(): void {
  cached = undefined;
}

/**
 * Em produção, alguns defaults de desenvolvimento são perigosos. Falhar aqui
 * é melhor do que descobrir em produção que o cookie não é `secure`.
 */
export function assertProductionSafety(env: Env): string[] {
  if (env.APP_ENV !== 'production') return [];

  const problems: string[] = [];
  if (!env.COOKIE_SECURE) problems.push('COOKIE_SECURE precisa ser true em produção (HTTPS).');
  if (env.API_PUBLIC_URL.startsWith('http://')) {
    problems.push('API_PUBLIC_URL precisa usar HTTPS em produção.');
  }
  if (env.WEB_PUBLIC_URL.startsWith('http://')) {
    problems.push('WEB_PUBLIC_URL precisa usar HTTPS em produção.');
  }
  if (env.HOST === '127.0.0.1') {
    problems.push('HOST 127.0.0.1 não aceita tráfego externo; use 0.0.0.0 atrás do proxy.');
  }
  return problems;
}
