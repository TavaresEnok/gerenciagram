import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

/**
 * Correlation ID (SPEC seção 13).
 *
 * Um id por requisição que atravessa API -> fila -> worker -> chamada à
 * plataforma. É o que permite pegar uma publicação específica que falhou às
 * 3h da manhã e reconstruir o caminho inteiro nos logs.
 *
 * Aceitamos um id vindo do cliente (`x-correlation-id`) para amarrar com
 * tracing externo, mas sanitizamos: um header arbitrário entraria em todos os
 * logs e viraria vetor de poluição/injeção no agregador.
 */

const HEADER = 'x-correlation-id';
const SAFE_ID = /^[A-Za-z0-9_-]{8,64}$/;

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
    /** Instante da chegada, para medir a latência real do handler. */
    startedAt: bigint;
  }
}

export const contextPlugin: FastifyPluginAsync = fp(async (app) => {
  app.decorateRequest('correlationId', '');
  app.decorateRequest('startedAt', 0n);

  app.addHook('onRequest', async (request, reply) => {
    const incoming = request.headers[HEADER];
    const candidate = Array.isArray(incoming) ? incoming[0] : incoming;

    request.correlationId = candidate && SAFE_ID.test(candidate) ? candidate : randomUUID();
    request.startedAt = process.hrtime.bigint();

    reply.header(HEADER, request.correlationId);
  });

  // Substitui o logger da requisição por um filho já com o correlation id,
  // para que todo log do handler saia amarrado sem ninguém precisar lembrar.
  app.addHook('onRequest', async (request) => {
    request.log = request.log.child({ correlationId: request.correlationId });
  });

  app.addHook('onResponse', async (request, reply) => {
    const durationMs = Number(process.hrtime.bigint() - request.startedAt) / 1_000_000;

    request.log.info(
      {
        method: request.method,
        route: request.routeOptions.url ?? request.url,
        status: reply.statusCode,
        durationMs: Number(durationMs.toFixed(2)),
      },
      'requisição concluída',
    );
  });
}, { name: 'context' });
