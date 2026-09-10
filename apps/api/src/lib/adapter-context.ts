import type { AdapterContext } from '@app/core';
import type { Container } from '../container.js';

/**
 * Monta o contexto entregue aos adapters.
 *
 * Existe para que nenhuma chamada a plataforma externa seja feita sem
 * correlation ID e sem timeout — os dois são exigência da SPEC (seções 12 e
 * 13), e um helper único é mais confiável do que lembrar disso em cada
 * ponto de chamada.
 */
export function adapterContext(
  container: Container,
  correlationId: string,
  timeoutMs = 30_000,
  signal?: AbortSignal,
): AdapterContext {
  const logger = container.logger.child({ correlationId });

  return {
    correlationId,
    timeoutMs,
    ...(signal ? { signal } : {}),
    logger: {
      debug: (msg, meta) => logger.debug(meta ?? {}, msg),
      info: (msg, meta) => logger.info(meta ?? {}, msg),
      warn: (msg, meta) => logger.warn(meta ?? {}, msg),
      error: (msg, meta) => logger.error(meta ?? {}, msg),
    },
  };
}
