import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { FastifyInstance, RawServerDefault } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from 'pino';

/**
 * A instância do Fastify já parametrizada com o logger do pino e o type
 * provider do Zod.
 *
 * Sem este alias, cada função que recebe o app teria que repetir os cinco
 * parâmetros genéricos — e usar o `FastifyInstance` cru faz o TypeScript
 * reclamar de incompatibilidade de logger a cada registro de rota.
 */
export type AppInstance = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  Logger,
  ZodTypeProvider
>;
