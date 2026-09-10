import type { AppInstance } from '../../types.js';
import { z } from 'zod';
import type { Container } from '../../container.js';

/**
 * Health checks para orquestração de containers (SPEC seção 13).
 *
 * A distinção entre os dois endpoints é o que evita o modo de falha clássico:
 *
 *  /healthz  — "o processo está vivo?". Não toca em dependência nenhuma.
 *              Se checasse o banco, uma queda do Postgres faria o
 *              orquestrador matar e recriar réplicas saudáveis em laço.
 *  /readyz   — "posso receber tráfego?". Verifica banco, Redis e storage.
 *              Falha aqui tira a réplica do balanceador sem reiniciá-la.
 */

const healthResponse = z.object({
  status: z.literal('ok'),
  uptimeSeconds: z.number(),
  version: z.string(),
});

const dependencySchema = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  latencyMs: z.number().optional(),
  message: z.string().optional(),
});

const readyResponse = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.object({
    database: dependencySchema,
    redis: dependencySchema,
    storage: dependencySchema,
  }),
});

const VERSION = process.env['npm_package_version'] ?? '0.1.0';

export async function registerHealthRoutes(
  app: AppInstance,
  container: Container,
): Promise<void> {
  app.get(
    '/healthz',
    {
      schema: {
        tags: ['Infraestrutura'],
        summary: 'Liveness — o processo está vivo',
        security: [],
        response: { 200: healthResponse },
      },
    },
    async () => ({
      status: 'ok' as const,
      uptimeSeconds: Math.round(process.uptime()),
      version: VERSION,
    }),
  );

  app.get(
    '/readyz',
    {
      schema: {
        tags: ['Infraestrutura'],
        summary: 'Readiness — dependências respondendo',
        security: [],
        response: { 200: readyResponse, 503: readyResponse },
      },
    },
    async (_request, reply) => {
      const [database, redis, storage] = await Promise.all([
        checkDatabase(container),
        checkRedis(container),
        checkStorage(container),
      ]);

      const ready = [database, redis, storage].every((check) => check.status === 'ok');

      return reply.status(ready ? 200 : 503).send({
        status: ready ? ('ready' as const) : ('not_ready' as const),
        checks: { database, redis, storage },
      });
    },
  );
}

type Check = z.infer<typeof dependencySchema>;

/** Toda checagem tem timeout: um health check que trava é pior que um que falha. */
async function withTiming(fn: () => Promise<void>, timeoutMs = 3000): Promise<Check> {
  const start = performance.now();
  try {
    await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`sem resposta em ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
    return { status: 'ok', latencyMs: Math.round(performance.now() - start) };
  } catch (error) {
    return {
      status: 'down',
      latencyMs: Math.round(performance.now() - start),
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkDatabase(container: Container): Promise<Check> {
  return withTiming(async () => {
    await container.prisma.$queryRaw`SELECT 1`;
  });
}

async function checkRedis(container: Container): Promise<Check> {
  return withTiming(async () => {
    const pong = await container.redis.ping();
    if (pong !== 'PONG') throw new Error(`resposta inesperada do Redis: ${pong}`);
  });
}

async function checkStorage(container: Container): Promise<Check> {
  return withTiming(async () => {
    // headObject numa chave inexistente valida credencial + conectividade
    // sem escrever nada no bucket.
    await container.storage.headObject('__healthcheck__');
  }, 5000);
}
