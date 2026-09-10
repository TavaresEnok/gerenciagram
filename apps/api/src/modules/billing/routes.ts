import { ForbiddenError, NotFoundError } from '@app/core';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { recordAudit } from '../../lib/audit.js';
import { requireAuth } from '../../plugins/auth.js';
import type { AppInstance } from '../../types.js';

/**
 * Planos, limites e feature flags (SPEC seções 6 e 14).
 *
 * Os limites vivem no BANCO (`Plan.limits`), com override por organização em
 * `Subscription.limitOverrides` — a especificação é explícita que limite de
 * plano nunca é hardcoded. Trocar de plano é mudar uma linha, não fazer deploy.
 *
 * NÃO há cobrança implementada. A integração com gateway de pagamento exige
 * credenciais e contrato que ainda não existem, e a SPEC (seção 19) proíbe
 * simular isso: os campos `externalCustomerId`/`externalSubscriptionId` estão
 * no modelo prontos para receber a integração real.
 */

const planSchema = z.object({
  tier: z.string(),
  name: z.string(),
  priceCents: z.number(),
  currency: z.string(),
  isActive: z.boolean(),
  limits: z.record(z.unknown()),
});

export async function registerBillingRoutes(
  app: AppInstance,
  container: Container,
): Promise<void> {
  const { prisma } = container;

  app.get(
    '/billing/plans',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Billing'],
        summary: 'Planos disponíveis e seus limites',
        response: { 200: z.object({ plans: z.array(planSchema) }) },
      },
    },
    async () => {
      const plans = await prisma.plan.findMany({
        where: { isActive: true },
        orderBy: { priceCents: 'asc' },
      });

      return {
        plans: plans.map((plan) => ({
          tier: plan.tier,
          name: plan.name,
          priceCents: plan.priceCents,
          currency: plan.currency,
          isActive: plan.isActive,
          limits: plan.limits as Record<string, unknown>,
        })),
      };
    },
  );

  app.get(
    '/billing/subscription',
    {
      preHandler: app.requirePermission('org:read'),
      schema: {
        tags: ['Billing'],
        summary: 'Assinatura atual, limites efetivos e uso',
        response: {
          200: z.object({
            plan: planSchema.nullable(),
            status: z.string().nullable(),
            currentPeriodEnd: z.string().nullable(),
            trialEndsAt: z.string().nullable(),
            /** Limites do plano já com os overrides negociados aplicados. */
            effectiveLimits: z.record(z.unknown()),
            usage: z.record(z.number()),
            /** Limites já atingidos ou ultrapassados. */
            exceeded: z.array(
              z.object({ limit: z.string(), used: z.number(), max: z.number() }),
            ),
            /**
             * Cobrança ainda não integrada a gateway de pagamento — a UI
             * mostra isso em vez de um botão que não faz nada.
             */
            paymentIntegrationActive: z.boolean(),
          }),
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);

      const subscription = await prisma.subscription.findUnique({
        where: { organizationId: auth.organizationId },
        include: { plan: true },
      });

      const [accounts, users, clients, groups, storage, scheduled] = await Promise.all([
        prisma.socialAccount.count({
          where: { organizationId: auth.organizationId, deletedAt: null },
        }),
        prisma.membership.count({
          where: { organizationId: auth.organizationId, deletedAt: null },
        }),
        prisma.client.count({ where: { organizationId: auth.organizationId, deletedAt: null } }),
        prisma.accountGroup.count({
          where: { organizationId: auth.organizationId, deletedAt: null },
        }),
        prisma.mediaAsset.aggregate({
          where: { organizationId: auth.organizationId, deletedAt: null },
          _sum: { sizeBytes: true },
        }),
        prisma.postTarget.count({
          where: {
            organizationId: auth.organizationId,
            status: { in: ['SCHEDULED', 'QUEUED'] },
            deletedAt: null,
          },
        }),
      ]);

      const usage: Record<string, number> = {
        maxSocialAccounts: accounts,
        maxUsers: users,
        maxClients: clients,
        maxAccountGroups: groups,
        maxStorageBytes: Number(storage._sum.sizeBytes ?? 0n),
        maxScheduledPosts: scheduled,
      };

      const effectiveLimits = subscription
        ? {
            ...(subscription.plan.limits as Record<string, unknown>),
            ...((subscription.limitOverrides as Record<string, unknown> | null) ?? {}),
          }
        : {};

      const exceeded: Array<{ limit: string; used: number; max: number }> = [];
      for (const [key, used] of Object.entries(usage)) {
        const max = effectiveLimits[key];
        // -1 significa ilimitado.
        if (typeof max === 'number' && max >= 0 && used >= max) {
          exceeded.push({ limit: key, used, max });
        }
      }

      return {
        plan: subscription
          ? {
              tier: subscription.plan.tier,
              name: subscription.plan.name,
              priceCents: subscription.plan.priceCents,
              currency: subscription.plan.currency,
              isActive: subscription.plan.isActive,
              limits: subscription.plan.limits as Record<string, unknown>,
            }
          : null,
        status: subscription?.status ?? null,
        currentPeriodEnd: subscription?.currentPeriodEnd?.toISOString() ?? null,
        trialEndsAt: subscription?.trialEndsAt?.toISOString() ?? null,
        effectiveLimits,
        usage,
        exceeded,
        paymentIntegrationActive: false,
      };
    },
  );

  app.post(
    '/billing/change-plan',
    {
      preHandler: app.requirePermission('org:manage_billing'),
      schema: {
        tags: ['Billing'],
        summary: 'Troca o plano da organização',
        description:
          'Sem gateway de pagamento configurado, a troca é registrada mas NÃO cobra ' +
          'nada. Rebaixar para um plano cujo limite já foi ultrapassado é recusado.',
        body: z.object({ tier: z.enum(['FREE', 'STARTER', 'PRO', 'AGENCY', 'ENTERPRISE']) }),
        response: {
          200: z.object({
            plan: planSchema,
            status: z.string(),
            paymentRequired: z.boolean(),
          }),
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);

      const plan = await prisma.plan.findUnique({ where: { tier: request.body.tier } });
      if (!plan) throw new NotFoundError('Plano', request.body.tier);

      const limits = plan.limits as Record<string, unknown>;

      // Rebaixar para um plano menor que o uso atual deixaria a organização
      // permanentemente acima do limite, sem nenhuma tela para resolver.
      const [accounts, users] = await Promise.all([
        prisma.socialAccount.count({
          where: { organizationId: auth.organizationId, deletedAt: null },
        }),
        prisma.membership.count({
          where: { organizationId: auth.organizationId, deletedAt: null },
        }),
      ]);

      const problems: string[] = [];
      const maxAccounts = limits['maxSocialAccounts'];
      const maxUsers = limits['maxUsers'];

      if (typeof maxAccounts === 'number' && maxAccounts >= 0 && accounts > maxAccounts) {
        problems.push(
          `${accounts} contas conectadas, e o plano ${plan.name} permite ${maxAccounts}.`,
        );
      }
      if (typeof maxUsers === 'number' && maxUsers >= 0 && users > maxUsers) {
        problems.push(`${users} usuários, e o plano ${plan.name} permite ${maxUsers}.`);
      }

      if (problems.length > 0) {
        throw new ForbiddenError(
          `Não é possível mudar para o plano ${plan.name}: ${problems.join(' ')}`,
        );
      }

      const subscription = await prisma.subscription.upsert({
        where: { organizationId: auth.organizationId },
        create: {
          organizationId: auth.organizationId,
          planId: plan.id,
          status: plan.priceCents === 0 ? 'ACTIVE' : 'TRIALING',
        },
        update: { planId: plan.id },
      });

      await recordAudit(prisma, {
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        action: 'billing.plan_change',
        entityType: 'Subscription',
        entityId: subscription.id,
        changes: { novoPlano: plan.tier },
        correlationId: request.correlationId,
      });

      return {
        plan: {
          tier: plan.tier,
          name: plan.name,
          priceCents: plan.priceCents,
          currency: plan.currency,
          isActive: plan.isActive,
          limits,
        },
        status: subscription.status,
        // Sinaliza para a UI que falta a etapa de pagamento, em vez de
        // fingir que a assinatura paga está ativa.
        paymentRequired: plan.priceCents > 0,
      };
    },
  );

  // --- Feature flags --------------------------------------------------------
  app.get(
    '/feature-flags',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Billing'],
        summary: 'Feature flags efetivas desta organização',
        description:
          'Permitem ligar/desligar uma integração ou módulo por organização sem deploy ' +
          '(SPEC seção 14) — necessário porque cada rede pode cair ou ficar com ' +
          'aprovação pendente em momentos diferentes.',
        response: {
          200: z.object({
            flags: z.array(
              z.object({
                key: z.string(),
                description: z.string(),
                enabled: z.boolean(),
                /** true quando o valor veio de um override da organização. */
                overridden: z.boolean(),
              }),
            ),
          }),
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);

      const [flags, overrides] = await Promise.all([
        prisma.featureFlag.findMany({ orderBy: { key: 'asc' } }),
        prisma.featureFlagOverride.findMany({
          where: { organizationId: auth.organizationId },
        }),
      ]);

      const overrideByKey = new Map(
        overrides.map((override) => [override.flagKey, override.enabled]),
      );

      return {
        flags: flags.map((flag) => ({
          key: flag.key,
          description: flag.description,
          enabled: overrideByKey.get(flag.key) ?? flag.enabledByDefault,
          overridden: overrideByKey.has(flag.key),
        })),
      };
    },
  );
}
