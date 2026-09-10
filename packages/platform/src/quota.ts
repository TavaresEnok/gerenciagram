import {
  QuotaExceededError,
  getPlatformDefinition,
  type PlatformKey,
  type QuotaRule,
  type QuotaSnapshot,
} from '@app/core';
import type { PrismaClient } from '@app/db';

/**
 * Controle de cota (SPEC seções 3 e 12).
 *
 * A distinção que sustenta este módulo: cota de CONTA é por perfil conectado;
 * cota de APP é do projeto/aplicativo e é compartilhada por TODOS os clientes
 * do SaaS. No YouTube, um cliente que agenda 100 vídeos consome a cota de
 * todos os outros — por isso a linha de cota de app não pertence a tenant
 * nenhum (`organizationId` e `socialAccountId` nulos).
 */

/**
 * Valor de `scopeKey` da linha de cota do aplicativo/projeto.
 *
 * Existe uma coluna dedicada em vez de `socialAccountId IS NULL` porque, no
 * Postgres, dois NULL não colidem numa restrição UNIQUE: a linha de cota de
 * app se duplicaria a cada worker concorrente e o limite compartilhado nunca
 * seria atingido.
 */
export const APP_SCOPE_KEY = 'APP';

export interface QuotaWindow {
  windowDate: Date;
  windowStart: Date;
  windowEnd: Date;
}

/**
 * Janela de 24h da plataforma, em UTC. `resetsAtUtcHour` existe porque nem
 * toda plataforma reseta à meia-noite UTC — a do YouTube vira à meia-noite no
 * Pacífico.
 */
export function quotaWindowFor(rule: QuotaRule, at: Date): QuotaWindow {
  const start = new Date(
    Date.UTC(
      at.getUTCFullYear(),
      at.getUTCMonth(),
      at.getUTCDate(),
      rule.resetsAtUtcHour,
      0,
      0,
      0,
    ),
  );
  if (start > at) start.setUTCDate(start.getUTCDate() - 1);

  const end = new Date(start);
  end.setUTCHours(end.getUTCHours() + rule.windowHours);

  const windowDate = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );

  return { windowDate, windowStart: start, windowEnd: end };
}

function scopeKeyFor(rule: QuotaRule, socialAccountId: string): string {
  return rule.scope === 'APP' ? APP_SCOPE_KEY : socialAccountId;
}

/** Consumo já registrado, no formato que o validador da SPEC seção 6.1 espera. */
export async function readQuotaSnapshot(
  prisma: PrismaClient,
  entries: Array<{ platform: PlatformKey; socialAccountId: string }>,
  at: Date,
): Promise<QuotaSnapshot> {
  const accountUsage = new Map<string, { count: number; units: number }>();
  const appUsage = new Map<string, { count: number; units: number }>();

  const platforms = [...new Set(entries.map((entry) => entry.platform))];
  if (platforms.length === 0) return { accountUsage, appUsage };

  for (const platform of platforms) {
    const def = getPlatformDefinition(platform);
    const rule = def.quotaRules.rules[0];
    if (!rule) continue;

    const { windowDate } = quotaWindowFor(rule, at);

    const accountIds = entries
      .filter((entry) => entry.platform === platform)
      .map((entry) => entry.socialAccountId);

    const rows = await prisma.platformQuotaUsage.findMany({
      where: {
        platform,
        windowDate,
        scopeKey: { in: [...accountIds, APP_SCOPE_KEY] },
      },
    });

    for (const row of rows) {
      const isApp = row.scopeKey === APP_SCOPE_KEY;
      const target = isApp ? appUsage : accountUsage;
      const key = isApp ? platform : `${platform}:${row.scopeKey}`;

      const current = target.get(key) ?? { count: 0, units: 0 };
      target.set(key, {
        count: current.count + row.count,
        units: current.units + row.units,
      });
    }
  }

  return { accountUsage, appUsage };
}

/**
 * Reserva a cota de uma publicação, ANTES de chamar a plataforma.
 *
 * Reservar antes (e devolver em caso de falha permanente) evita a corrida em
 * que dois workers checam "tem cota" ao mesmo tempo e ambos publicam. Quem
 * decide é o incremento atômico do banco, não a leitura anterior.
 */
export async function reserveQuota(
  prisma: PrismaClient,
  input: {
    platform: PlatformKey;
    socialAccountId: string;
    organizationId: string;
    at: Date;
  },
): Promise<void> {
  const def = getPlatformDefinition(input.platform);

  for (const rule of def.quotaRules.rules) {
    const window = quotaWindowFor(rule, input.at);
    const isApp = rule.scope === 'APP';
    const scopeKey = scopeKeyFor(rule, input.socialAccountId);

    const countDelta = rule.unit === 'POSTS' ? rule.costPerPublish : 0;
    const unitsDelta = rule.unit === 'UNITS' ? rule.costPerPublish : 0;

    const row = await prisma.platformQuotaUsage.upsert({
      where: {
        platform_scopeKey_windowDate: {
          platform: input.platform,
          scopeKey,
          windowDate: window.windowDate,
        },
      },
      create: {
        platform: input.platform,
        scopeKey,
        socialAccountId: isApp ? null : input.socialAccountId,
        organizationId: isApp ? null : input.organizationId,
        windowDate: window.windowDate,
        windowStart: window.windowStart,
        windowEnd: window.windowEnd,
        count: countDelta,
        units: unitsDelta,
        limitCount: rule.unit === 'POSTS' ? rule.limit : null,
        limitUnits: rule.unit === 'UNITS' ? rule.limit : null,
      },
      update: {
        count: { increment: countDelta },
        units: { increment: unitsDelta },
      },
    });

    const used = rule.unit === 'POSTS' ? row.count : row.units;
    if (used <= rule.limit) continue;

    // Estourou: devolve o que acabou de reservar e sinaliza para o worker
    // REAGENDAR, em vez de gastar tentativa contra um limite já atingido.
    await prisma.platformQuotaUsage.update({
      where: { id: row.id },
      data: {
        count: { decrement: countDelta },
        units: { decrement: unitsDelta },
      },
    });

    // Limite não confirmado na documentação oficial não bloqueia
    // (regra 6 da SPEC): seguimos e deixamos a própria plataforma decidir.
    if (!def.quotaRules.verified) continue;

    throw new QuotaExceededError(def.displayName, rule.scope, window.windowEnd);
  }
}

/**
 * Devolve a cota reservada quando a publicação falha de forma permanente.
 *
 * `updateMany` em vez de `update`: quando a publicação falhou ANTES de
 * reservar (revisão de IA pendente, circuito aberto, validação), não existe
 * linha para decrementar. O `update` lançaria e encheria o log de um erro que
 * não é erro; o `updateMany` simplesmente não afeta nenhuma linha.
 */
export async function releaseQuota(
  prisma: PrismaClient,
  input: { platform: PlatformKey; socialAccountId: string; at: Date },
): Promise<void> {
  const def = getPlatformDefinition(input.platform);

  for (const rule of def.quotaRules.rules) {
    const window = quotaWindowFor(rule, input.at);

    await prisma.platformQuotaUsage.updateMany({
      where: {
        platform: input.platform,
        scopeKey: scopeKeyFor(rule, input.socialAccountId),
        windowDate: window.windowDate,
      },
      data: {
        count: { decrement: rule.unit === 'POSTS' ? rule.costPerPublish : 0 },
        units: { decrement: rule.unit === 'UNITS' ? rule.costPerPublish : 0 },
      },
    });
  }
}

/** Quando a janela atual reseta — usado para reagendar em vez de re-tentar. */
export function nextQuotaResetAt(platform: PlatformKey, at: Date): Date {
  const def = getPlatformDefinition(platform);
  const rule = def.quotaRules.rules[0];
  if (!rule) return new Date(at.getTime() + 60 * 60_000);
  return quotaWindowFor(rule, at).windowEnd;
}
