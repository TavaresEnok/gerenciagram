import { PLATFORM_KEYS } from '@app/core';
import type { AppInstance } from '../../types.js';
import { z } from 'zod';
import type { Container } from '../../container.js';

/**
 * Catálogo de plataformas para a interface.
 *
 * É daqui que a UI aprende que o Kwai está indisponível, que o YouTube exige
 * título, quais campos obrigatórios renderizar por conta e qual a política de
 * conteúdo duplicado. Nenhuma dessas regras é duplicada no frontend — se
 * estivesse, o dia em que a plataforma mudar a regra o backend bloquearia e a
 * tela continuaria deixando agendar.
 */

const capabilitySchema = z.object({
  level: z.enum(['SUPPORTED', 'PARTIAL', 'UNSUPPORTED', 'UNKNOWN']),
  requiresAppReview: z.boolean(),
  requiresBusinessAccount: z.boolean(),
  limitation: z.string().optional(),
});

const platformSchema = z.object({
  key: z.enum(PLATFORM_KEYS),
  displayName: z.string(),
  isAvailable: z.boolean(),
  unavailableReason: z.string().nullable(),
  /** Credenciais do app preenchidas NESTE ambiente. */
  credentialsConfigured: z.boolean(),
  /** Só é possível conectar conta quando as duas coisas são verdadeiras. */
  canConnect: z.boolean(),
  capabilities: z.record(capabilitySchema),
  mediaRequirements: z.record(z.unknown()),
  quotaRules: z.record(z.unknown()),
  duplicateContentPolicy: z.record(z.unknown()),
  requiredUxFields: z.record(z.unknown()),
  docsUrl: z.string().nullable(),
  circuitState: z.enum(['CLOSED', 'OPEN', 'HALF_OPEN']),
});

export async function registerPlatformRoutes(
  app: AppInstance,
  container: Container,
): Promise<void> {
  app.get(
    '/platforms',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Plataformas'],
        summary: 'Lista as redes sociais e o que cada uma suporta neste ambiente',
        response: { 200: z.object({ platforms: z.array(platformSchema) }) },
      },
    },
    async () => {
      const rows = await container.prisma.socialPlatform.findMany({
        orderBy: [{ isAvailable: 'desc' }, { displayName: 'asc' }],
      });

      return {
        platforms: rows.map((row) => ({
          key: row.key,
          displayName: row.displayName,
          isAvailable: row.isAvailable,
          unavailableReason: row.unavailableReason,
          credentialsConfigured: container.configuredPlatforms.has(row.key),
          canConnect: row.isAvailable && container.configuredPlatforms.has(row.key),
          capabilities: row.capabilities as unknown as Record<string, z.infer<typeof capabilitySchema>>,
          mediaRequirements: row.mediaRequirements as Record<string, unknown>,
          quotaRules: row.quotaRules as Record<string, unknown>,
          duplicateContentPolicy: row.duplicateContentPolicy as Record<string, unknown>,
          requiredUxFields: row.requiredUxFields as Record<string, unknown>,
          docsUrl: row.docsUrl,
          circuitState: row.circuitState,
        })),
      };
    },
  );
}
