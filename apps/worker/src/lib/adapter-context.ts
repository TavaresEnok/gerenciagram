import type { AdapterContext } from '@app/core';
import type { WorkerContainer } from '../container.js';

/**
 * Contexto entregue aos adapters no worker.
 *
 * O timeout padrão é bem maior que o da API porque aqui se envia vídeo: uma
 * chamada de metadados leva milissegundos, um upload de 2 GB leva minutos.
 * O que não muda é a existência do timeout (SPEC seção 12).
 */
export function adapterContext(
  container: WorkerContainer,
  correlationId: string,
  timeoutMs = 120_000,
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
