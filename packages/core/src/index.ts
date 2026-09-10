/**
 * @app/core — núcleo de domínio.
 *
 * Regra da SPEC seção 4: o núcleo nunca depende da implementação de uma rede
 * específica, só das interfaces daqui. Este pacote não importa Prisma,
 * Fastify, BullMQ nem SDK de plataforma nenhuma — é isso que permite testar
 * as regras de agendamento, validação e RBAC sem subir infraestrutura.
 */

export * from './errors.js';
export * from './idempotency.js';

export * from './platform/capabilities.js';
export * from './platform/registry.js';

export * from './adapters/types.js';
export * from './adapters/social-media-adapter.js';

export * from './rbac/permissions.js';

export * from './scheduling/timezone.js';
export * from './scheduling/slots.js';

export * from './validation/similarity.js';
export * from './validation/target-validator.js';

export * from './resilience/retry.js';
export * from './resilience/circuit-breaker.js';

export * from './content/variants.js';

export * from './jobs/contracts.js';
