import type { AppInstance } from '../types.js';
import type { Container } from '../container.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerHealthRoutes } from './health/routes.js';
import { registerPlatformRoutes } from './platforms/routes.js';

/**
 * Registro dos módulos.
 *
 * Health checks ficam FORA do /v1: são contrato de infraestrutura com o
 * orquestrador, não API de produto, e não devem mudar quando a API versionar
 * (SPEC seção 16).
 */
export async function registerModules(
  app: AppInstance,
  container: Container,
): Promise<void> {
  await registerHealthRoutes(app, container);

  await app.register(
    async (v1: AppInstance) => {
      await registerAuthRoutes(v1, container);
      await registerPlatformRoutes(v1, container);
    },
    { prefix: '/v1' },
  );
}
