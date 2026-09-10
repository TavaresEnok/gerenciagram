import { pino, type Logger } from 'pino';

/**
 * Logs estruturados com correlation ID (SPEC seção 13).
 *
 * A lista de `redact` não é opcional: token de acesso, senha, cookie e header
 * de autorização passando por um log estruturado acabam num agregador de
 * terceiros. Redigimos por caminho para não depender de ninguém lembrar.
 */

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  '*.accessToken',
  '*.refreshToken',
  '*.accessTokenEnc',
  '*.refreshTokenEnc',
  '*.password',
  '*.passwordHash',
  '*.clientSecret',
  '*.twoFactorSecret',
  'credentials.accessToken',
  'credentials.refreshToken',
  'body.password',
  'body.newPassword',
  'body.currentPassword',
];

export interface LoggerOptions {
  level: string;
  pretty: boolean;
  serviceName: string;
}

export function createLogger(options: LoggerOptions): Logger {
  return pino({
    level: options.level,
    base: { service: options.serviceName },
    redact: { paths: REDACT_PATHS, censor: '[REDIGIDO]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    ...(options.pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service' },
          },
        }
      : {}),
  });
}

export type { Logger };
