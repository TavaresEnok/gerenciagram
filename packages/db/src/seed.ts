import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

// Carrega o .env da raiz antes de qualquer coisa: o seed roda tanto por
// `pnpm db:seed` quanto pelo `prisma migrate`, e nos dois casos o cwd é
// diferente. Sem isto, seria um "passo manual escondido" (SPEC seção 18).
loadEnv({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env'),
  quiet: true,
});

import { hasCredentials, listPlatformDefinitions } from '@app/core';
import { PrismaClient } from '../generated/client/index.js';
import type { Prisma } from '../generated/client/index.js';

/**
 * Seed idempotente (roda quantas vezes precisar).
 *
 * Semeia só dados de CATÁLOGO — plataformas, planos e feature flags. Nunca
 * cria organização, usuário ou conta social de mentira: a SPEC (seção 19)
 * proíbe dado fabricado que se pareça com uso real.
 */

const prisma = new PrismaClient();

async function seedPlatforms(): Promise<void> {
  for (const def of listPlatformDefinitions()) {
    const credentialsConfigured = hasCredentials(def, process.env);

    const data = {
      displayName: def.displayName,
      isAvailable: def.isAvailable,
      unavailableReason: def.unavailableReason,
      capabilities: def.capabilities as unknown as Prisma.InputJsonValue,
      mediaRequirements: def.mediaRequirements as unknown as Prisma.InputJsonValue,
      quotaRules: def.quotaRules as unknown as Prisma.InputJsonValue,
      duplicateContentPolicy: def.duplicateContentPolicy as unknown as Prisma.InputJsonValue,
      requiredUxFields: def.requiredUxFields as unknown as Prisma.InputJsonValue,
      oauthScopes: def.oauthScopes,
      docsUrl: def.docsUrl,
      credentialsConfigured,
    };

    await prisma.socialPlatform.upsert({
      where: { key: def.key },
      // O estado do circuit breaker NÃO é resetado no update: um seed durante
      // um incidente não pode fechar um circuito que está aberto por motivo.
      update: data,
      create: { key: def.key, ...data },
    });

    const status = !def.isAvailable
      ? 'indisponível (não implementada)'
      : credentialsConfigured
        ? 'pronta'
        : 'implementada, sem credenciais neste ambiente';

    console.log(`  ${def.displayName.padEnd(12)} ${status}`);
  }
}

/**
 * Limites de plano vivem no banco (SPEC seções 6 e 19: "nunca hardcoded").
 * Os valores abaixo são o padrão inicial e podem ser editados pelo painel
 * admin sem deploy.
 */
async function seedPlans(): Promise<void> {
  const plans = [
    {
      tier: 'FREE' as const,
      name: 'Free',
      priceCents: 0,
      limits: {
        maxSocialAccounts: 3,
        maxUsers: 1,
        maxClients: 1,
        maxAccountGroups: 1,
        maxScheduledPosts: 30,
        maxStorageBytes: 1_073_741_824,
        aiCreditsPerMonth: 0,
        requiresTwoFactorForAdmins: false,
        features: ['calendar', 'queue'],
      },
    },
    {
      tier: 'STARTER' as const,
      name: 'Starter',
      priceCents: 9900,
      limits: {
        maxSocialAccounts: 10,
        maxUsers: 3,
        maxClients: 3,
        maxAccountGroups: 5,
        maxScheduledPosts: 300,
        maxStorageBytes: 10_737_418_240,
        aiCreditsPerMonth: 100,
        requiresTwoFactorForAdmins: false,
        features: ['calendar', 'queue', 'analytics', 'ai'],
      },
    },
    {
      tier: 'PRO' as const,
      name: 'Pro',
      priceCents: 24900,
      limits: {
        maxSocialAccounts: 30,
        maxUsers: 10,
        maxClients: 10,
        maxAccountGroups: 20,
        maxScheduledPosts: 2000,
        maxStorageBytes: 107_374_182_400,
        aiCreditsPerMonth: 500,
        requiresTwoFactorForAdmins: true,
        features: ['calendar', 'queue', 'analytics', 'ai', 'approval', 'reports', 'inbox'],
      },
    },
    {
      tier: 'AGENCY' as const,
      name: 'Agency',
      priceCents: 59900,
      limits: {
        maxSocialAccounts: 100,
        maxUsers: 30,
        maxClients: 50,
        maxAccountGroups: 100,
        maxScheduledPosts: 10000,
        maxStorageBytes: 536_870_912_000,
        aiCreditsPerMonth: 2000,
        requiresTwoFactorForAdmins: true,
        features: [
          'calendar',
          'queue',
          'analytics',
          'ai',
          'approval',
          'reports',
          'inbox',
          'campaigns',
          'white_label',
        ],
      },
    },
    {
      tier: 'ENTERPRISE' as const,
      name: 'Enterprise',
      priceCents: 0, // sob consulta
      limits: {
        maxSocialAccounts: -1, // -1 = ilimitado
        maxUsers: -1,
        maxClients: -1,
        maxAccountGroups: -1,
        maxScheduledPosts: -1,
        maxStorageBytes: -1,
        aiCreditsPerMonth: -1,
        requiresTwoFactorForAdmins: true,
        features: [
          'calendar',
          'queue',
          'analytics',
          'ai',
          'approval',
          'reports',
          'inbox',
          'campaigns',
          'white_label',
          'sso',
          'audit_export',
        ],
      },
    },
  ];

  for (const plan of plans) {
    await prisma.plan.upsert({
      where: { tier: plan.tier },
      update: {
        name: plan.name,
        priceCents: plan.priceCents,
        limits: plan.limits as unknown as Prisma.InputJsonValue,
      },
      create: {
        tier: plan.tier,
        name: plan.name,
        priceCents: plan.priceCents,
        limits: plan.limits as unknown as Prisma.InputJsonValue,
      },
    });
    console.log(`  plano ${plan.name}`);
  }
}

/**
 * Feature flags (SPEC seção 14): permitem desligar uma integração por
 * organização sem deploy — necessário porque cada rede pode cair ou ficar com
 * aprovação pendente em momentos diferentes.
 */
async function seedFeatureFlags(): Promise<void> {
  const flags = [
    { key: 'platform.youtube', description: 'Integração com o YouTube', enabledByDefault: true },
    { key: 'platform.instagram', description: 'Integração com o Instagram', enabledByDefault: false },
    { key: 'platform.facebook', description: 'Integração com o Facebook', enabledByDefault: false },
    { key: 'platform.tiktok', description: 'Integração com o TikTok', enabledByDefault: false },
    { key: 'platform.x', description: 'Integração com o X', enabledByDefault: false },
    { key: 'platform.kwai', description: 'Integração com o Kwai', enabledByDefault: false },
    { key: 'module.ai', description: 'Módulo de geração por IA', enabledByDefault: false },
    { key: 'module.inbox', description: 'Inbox de comentários e mensagens', enabledByDefault: false },
    { key: 'module.approval', description: 'Workflow de aprovação', enabledByDefault: true },
    { key: 'module.reports', description: 'Relatórios em PDF/CSV', enabledByDefault: true },
    {
      key: 'publishing.queue_slots',
      description: 'Fila por slots (grade semanal por conta)',
      enabledByDefault: true,
    },
  ];

  for (const flag of flags) {
    await prisma.featureFlag.upsert({
      where: { key: flag.key },
      update: { description: flag.description },
      create: flag,
    });
  }
  console.log(`  ${flags.length} feature flags`);
}

async function main(): Promise<void> {
  console.log('Semeando catálogo...\n');

  console.log('Plataformas:');
  await seedPlatforms();

  console.log('\nPlanos:');
  await seedPlans();

  console.log('\nFeature flags:');
  await seedFeatureFlags();

  console.log('\nSeed concluído.');
}

main()
  .catch((error: unknown) => {
    console.error('Falha no seed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
