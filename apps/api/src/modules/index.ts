import type { Container } from '../container.js';
import type { AppInstance } from '../types.js';
import { registerAccountRoutes } from './accounts/routes.js';
import { registerAdminRoutes } from './admin/routes.js';
import { registerAiRoutes } from './ai/routes.js';
import { registerAnalyticsRoutes } from './analytics/routes.js';
import { registerApprovalRoutes } from './approvals/routes.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerBillingRoutes } from './billing/routes.js';
import { registerCampaignRoutes } from './campaigns/routes.js';
import { registerClientRoutes } from './clients/routes.js';
import { registerContentRoutes } from './contents/routes.js';
import { registerGroupRoutes } from './groups/routes.js';
import { registerHealthRoutes } from './health/routes.js';
import { registerInboxRoutes, registerNotificationRoutes } from './inbox/routes.js';
import { registerMediaRoutes } from './media/routes.js';
import { registerOrganizationRoutes } from './organizations/routes.js';
import { registerPlatformRoutes } from './platforms/routes.js';
import { registerPostRoutes } from './posts/routes.js';
import { registerReportRoutes } from './reports/routes.js';
import { registerWebhookRoutes } from './webhooks/routes.js';

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
      // Identidade e tenant
      await registerAuthRoutes(v1, container);
      await registerOrganizationRoutes(v1, container);
      await registerClientRoutes(v1, container);

      // Contas e grupos
      await registerAccountRoutes(v1, container);
      await registerGroupRoutes(v1, container);
      await registerPlatformRoutes(v1, container);

      // Conteúdo e publicação
      await registerMediaRoutes(v1, container);
      await registerContentRoutes(v1, container);
      await registerPostRoutes(v1, container);
      await registerApprovalRoutes(v1, container);
      await registerCampaignRoutes(v1, container);

      // Dados e comunicação
      await registerAnalyticsRoutes(v1, container);
      await registerReportRoutes(v1, container);
      await registerInboxRoutes(v1, container);
      await registerNotificationRoutes(v1, container);
      await registerAiRoutes(v1, container);

      // Plataforma
      await registerBillingRoutes(v1, container);
      await registerAdminRoutes(v1, container);
      await registerWebhookRoutes(v1, container);
    },
    { prefix: '/v1' },
  );
}
