import type { PrismaClient } from '@app/db';

/**
 * Log de auditoria (SPEC seção 10).
 *
 * Registra QUEM fez O QUÊ, EM QUÊ e DE ONDE. Nunca grava segredo: o `changes`
 * passa por uma limpeza que remove campos sensíveis, porque a tentação de
 * gravar "o objeto inteiro que mudou" é exatamente como senha e token acabam
 * num log retido por anos.
 */

const SENSITIVE_KEYS = new Set([
  'password',
  'passwordHash',
  'newPassword',
  'currentPassword',
  'accessToken',
  'refreshToken',
  'accessTokenEnc',
  'refreshTokenEnc',
  'clientSecret',
  'twoFactorSecret',
  'twoFactorRecoveryCodes',
  'refreshTokenHash',
  'tokenHash',
]);

export interface AuditInput {
  organizationId?: string | null;
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  changes?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
}

export function sanitizeChanges(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[profundo demais]';
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) return value.map((item) => sanitizeChanges(item, depth + 1));

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SENSITIVE_KEYS.has(key) ? '[REDIGIDO]' : sanitizeChanges(item, depth + 1);
  }
  return result;
}

/**
 * A escrita nunca derruba a operação principal: perder uma linha de auditoria
 * é ruim, mas falhar uma publicação porque o log de auditoria caiu é pior.
 * A falha vira log de erro para ser notada.
 */
export async function recordAudit(
  prisma: PrismaClient,
  input: AuditInput,
  onError?: (error: unknown) => void,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        organizationId: input.organizationId ?? null,
        actorUserId: input.actorUserId ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        changes: input.changes
          ? (sanitizeChanges(input.changes) as object)
          : undefined,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent?.slice(0, 500) ?? null,
        correlationId: input.correlationId ?? null,
      },
    });
  } catch (error) {
    onError?.(error);
  }
}
