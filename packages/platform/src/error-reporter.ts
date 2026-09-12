import * as Sentry from '@sentry/node';

/**
 * Relato de erros para um coletor externo (Sentry).
 *
 * Referências oficiais consultadas em 2026-09-12:
 *   https://docs.sentry.io/platforms/javascript/guides/fastify/
 *   https://docs.sentry.io/platforms/javascript/guides/node/enriching-events/scopes/
 *   https://docs.sentry.io/platforms/javascript/configuration/draining/
 *
 * Três decisões:
 *
 *  - **Sem `SENTRY_DSN`, o relator é um no-op explícito.** Não há "modo
 *    simulado": ou os erros vão para o Sentry, ou `enabled` é `false` e o
 *    log continua sendo o único canal — como sempre foi.
 *  - **Só captura manual, sem auto-instrumentação.** A documentação exige
 *    carregar o SDK com `node --import` ANTES de qualquer outro módulo para
 *    instrumentar Fastify e Prisma. Isso mudaria o boot dos dois processos
 *    e das imagens Docker para ganhar tracing, que ninguém pediu. A captura
 *    manual (`captureException`) não tem essa exigência.
 *  - **Não usamos `setupFastifyErrorHandler`.** A API já tem um
 *    `setErrorHandler` próprio que decide o status de cada erro, e a
 *    documentação não diz como os dois convivem. Em vez de apostar, o
 *    plugin de erros chama `capture` no ramo de erro inesperado — o único
 *    que interessa ao Sentry. 404, 422 e erro de domínio são comportamento
 *    esperado, não incidente.
 *
 * Nada de PII: `sendDefaultPii` fica no padrão (desligado), e o contexto
 * aceito aqui são identificadores — nunca token, e-mail ou corpo de post.
 */

export interface ErrorContext {
  correlationId?: string | undefined;
  organizationId?: string | null | undefined;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
}

export interface ErrorReporter {
  readonly enabled: boolean;
  capture(error: unknown, context?: ErrorContext): void;
  /** Esvazia a fila de envio e desliga o SDK. Chamar só no encerramento. */
  close(timeoutMs?: number): Promise<void>;
}

export interface ErrorReporterOptions {
  dsn?: string | undefined;
  environment: string;
  /** Distingue API e worker no mesmo projeto do Sentry. */
  serviceName: string;
}

const NOOP: ErrorReporter = {
  enabled: false,
  capture: () => undefined,
  close: async () => undefined,
};

export function createErrorReporter(options: ErrorReporterOptions): ErrorReporter {
  const dsn = options.dsn?.trim();
  if (!dsn) return NOOP;

  Sentry.init({
    dsn,
    environment: options.environment,
    // Sem tracing: ver o comentário do módulo sobre auto-instrumentação.
    tracesSampleRate: 0,
  });

  return {
    enabled: true,

    capture(error: unknown, context: ErrorContext = {}): void {
      Sentry.withScope((scope) => {
        scope.setTag('service', options.serviceName);
        if (context.correlationId) scope.setTag('correlationId', context.correlationId);
        if (context.organizationId) scope.setTag('organizationId', context.organizationId);
        for (const [chave, valor] of Object.entries(context.tags ?? {})) {
          scope.setTag(chave, valor);
        }
        if (context.extra) scope.setExtras(context.extra);

        Sentry.captureException(error);
      });
    },

    async close(timeoutMs = 2_000): Promise<void> {
      // `close` e não `flush`: pela documentação, `close` é o indicado
      // imediatamente antes de encerrar o processo.
      await Sentry.close(timeoutMs);
    },
  };
}
