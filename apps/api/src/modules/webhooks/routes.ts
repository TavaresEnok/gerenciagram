import { PLATFORM_KEYS, type PlatformKey } from '@app/core';
import { z } from 'zod';
import type { Container } from '../../container.js';
import type { AppInstance } from '../../types.js';

/**
 * Webhooks das plataformas (SPEC seção 16).
 *
 * Três garantias, nesta ordem:
 *
 *  1. ASSINATURA VERIFICADA antes de qualquer coisa. Um webhook sem
 *     verificação é um endpoint público que qualquer um usa para injetar
 *     eventos no sistema.
 *  2. PROCESSAMENTO ASSÍNCRONO. Respondemos 200 rápido e processamos depois:
 *     plataformas desativam webhooks que demoram a responder.
 *  3. IDEMPOTÊNCIA por (plataforma, id do evento). Reentrega é comportamento
 *     normal dessas plataformas, não exceção.
 *
 * O corpo é lido como Buffer CRU: recalcular a assinatura sobre o JSON
 * re-serializado falha, porque a ordem das chaves e o espaçamento mudam.
 */

export async function registerWebhookRoutes(
  app: AppInstance,
  container: Container,
): Promise<void> {
  // Guarda o corpo cru só nas rotas de webhook — o resto da API continua
  // recebendo JSON já interpretado.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request, body: Buffer, done) => {
      if (request.url.startsWith('/v1/webhooks/')) {
        (request as { rawBody?: Buffer }).rawBody = body;
      }
      try {
        done(null, body.length > 0 ? JSON.parse(body.toString('utf8')) : {});
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  /**
   * Desafio de verificação de subscrição. Várias plataformas (Meta, por
   * exemplo) fazem um GET com um token antes de começar a entregar eventos.
   */
  app.get(
    '/webhooks/:platform',
    {
      schema: {
        tags: ['Webhooks'],
        summary: 'Responde ao desafio de verificação da plataforma',
        security: [],
        params: z.object({ platform: z.enum(PLATFORM_KEYS) }),
        querystring: z.record(z.string()).optional(),
      },
    },
    async (request, reply) => {
      const platform = request.params.platform as PlatformKey;

      if (!container.adapters.has(platform)) {
        return reply.status(404).send({ error: 'plataforma não suportada' });
      }

      const adapter = container.adapters.get(platform);
      const challenge = adapter.webhooks?.handleSubscriptionChallenge?.(
        (request.query ?? {}) as Record<string, string | undefined>,
      );

      if (challenge === null || challenge === undefined) {
        request.log.warn({ platform }, 'desafio de webhook recusado');
        return reply.status(403).send({ error: 'desafio inválido' });
      }

      return reply.status(200).type('text/plain').send(challenge);
    },
  );

  app.post(
    '/webhooks/:platform',
    {
      config: {
        // Plataformas entregam em rajada; o limite global da API é apertado
        // demais e derrubaria entregas legítimas.
        rateLimit: { max: 1000, timeWindow: 60_000 },
      },
      schema: {
        tags: ['Webhooks'],
        summary: 'Recebe eventos da plataforma',
        security: [],
        params: z.object({ platform: z.enum(PLATFORM_KEYS) }),
      },
    },
    async (request, reply) => {
      const platform = request.params.platform as PlatformKey;
      const rawBody = (request as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);

      if (!container.adapters.has(platform)) {
        return reply.status(404).send({ error: 'plataforma não suportada' });
      }

      const adapter = container.adapters.get(platform);

      // Sem verificador de assinatura implementado, RECUSAMOS. Aceitar
      // evento não verificado seria uma porta aberta.
      if (!adapter.webhooks) {
        request.log.warn(
          { platform },
          'webhook recebido para plataforma sem verificação de assinatura implementada',
        );
        return reply.status(501).send({
          error:
            'Os webhooks desta plataforma ainda não estão implementados neste ambiente.',
        });
      }

      const headers = request.headers as Record<string, string | undefined>;
      const signatureValid = adapter.webhooks.verifySignature(rawBody, headers);

      if (!signatureValid) {
        request.log.warn({ platform, ip: request.ip }, 'webhook com assinatura inválida');
        // 401 sem detalhe: não ajudamos quem está tentando forjar.
        return reply.status(401).send({ error: 'assinatura inválida' });
      }

      const payload = (request.body ?? {}) as Record<string, unknown>;
      const remoteEventId = extractEventId(payload);

      try {
        await container.prisma.webhookEvent.create({
          data: {
            platform,
            remoteEventId,
            eventType: extractEventType(payload),
            payload: payload as object,
            headers: sanitizeHeaders(headers) as object,
            signatureValid: true,
          },
        });
      } catch (error) {
        // Colisão na UNIQUE (plataforma, remoteEventId) = reentrega do mesmo
        // evento. Responder 200 é o correto: já temos o evento, e devolver
        // erro faria a plataforma tentar de novo indefinidamente.
        const code = (error as { code?: string }).code;
        if (code === 'P2002') {
          request.log.debug({ platform, remoteEventId }, 'webhook reentregue — já registrado');
          return reply.status(200).send({ received: true, duplicate: true });
        }
        throw error;
      }

      // Resposta imediata; o processamento roda na fila.
      return reply.status(200).send({ received: true });
    },
  );
}

function extractEventId(payload: Record<string, unknown>): string | null {
  for (const key of ['id', 'event_id', 'eventId', 'notification_id']) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function extractEventType(payload: Record<string, unknown>): string | null {
  for (const key of ['type', 'event', 'event_type', 'object']) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * Guarda só os headers úteis para diagnóstico. Cookie e Authorization não
 * entram: um webhook malformado poderia trazê-los, e eles ficariam gravados.
 */
function sanitizeHeaders(
  headers: Record<string, string | undefined>,
): Record<string, string> {
  const allowed = [
    'content-type',
    'user-agent',
    'x-hub-signature',
    'x-hub-signature-256',
    'x-request-id',
  ];

  const result: Record<string, string> = {};
  for (const key of allowed) {
    const value = headers[key];
    if (typeof value === 'string') result[key] = value.slice(0, 500);
  }
  return result;
}
