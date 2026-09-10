import { PrismaClient, Prisma } from '@prisma/client';

/**
 * Cliente Prisma e as garantias de multi-tenant.
 *
 * A SPEC (seção 8) exige isolamento "em nível de consulta, não só de
 * aplicação". Duas coisas sustentam isso aqui:
 *
 *  1. `tenantWhere()` — helper obrigatório em toda leitura de entidade com
 *     dono, que sempre injeta `organizationId` e `deletedAt: null`.
 *  2. `assertTenant()` — checagem defensiva depois de buscar por id, para o
 *     caso de alguém esquecer o helper. É barata e transforma um vazamento
 *     silencioso entre organizações numa exceção.
 */

export * from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export interface PrismaOptions {
  databaseUrl?: string;
  /** Loga a query e o tempo — útil para caçar o que estoura o p95 de 300ms. */
  logQueries?: boolean;
}

export function createPrismaClient(options: PrismaOptions = {}): PrismaClient {
  const log: Prisma.LogLevel[] = options.logQueries
    ? ['query', 'warn', 'error']
    : ['warn', 'error'];

  return new PrismaClient({
    log,
    ...(options.databaseUrl
      ? { datasources: { db: { url: options.databaseUrl } } }
      : {}),
  });
}

/**
 * Em desenvolvimento o hot reload recria o módulo a cada mudança; sem o
 * singleton, cada recarga abre um novo pool e o Postgres esgota conexões.
 */
export function getPrismaClient(options: PrismaOptions = {}): PrismaClient {
  if (process.env.NODE_ENV === 'production') {
    return createPrismaClient(options);
  }
  globalForPrisma.prisma ??= createPrismaClient(options);
  return globalForPrisma.prisma;
}

// ---------------------------------------------------------------------------
//  Multi-tenant
// ---------------------------------------------------------------------------

/**
 * Filtro base de qualquer consulta de tenant.
 *
 * `deletedAt: null` vem junto de propósito: soft-delete que precisa ser
 * lembrado a cada consulta acaba esquecido, e registros apagados voltam a
 * aparecer em relatório.
 */
export function tenantWhere(organizationId: string) {
  return { organizationId, deletedAt: null } as const;
}

/** Igual ao anterior, mas incluindo os registros apagados (auditoria, LGPD). */
export function tenantWhereWithDeleted(organizationId: string) {
  return { organizationId } as const;
}

export class TenantIsolationError extends Error {
  constructor(entity: string, entityId: string) {
    super(
      `Isolamento entre organizações violado ao acessar ${entity}(${entityId}). ` +
        `A consulta não filtrou por organizationId.`,
    );
    this.name = 'TenantIsolationError';
  }
}

/**
 * Confere que o registro carregado pertence mesmo à organização do
 * requisitante. Existe para falhar alto em vez de vazar dado entre tenants.
 */
export function assertTenant<T extends { id: string; organizationId: string }>(
  entity: string,
  record: T | null,
  organizationId: string,
): T | null {
  if (record === null) return null;
  if (record.organizationId !== organizationId) {
    throw new TenantIsolationError(entity, record.id);
  }
  return record;
}

/** Marca como apagado em vez de remover (LGPD + histórico de relatórios). */
export function softDeleteData() {
  return { deletedAt: new Date() };
}

// ---------------------------------------------------------------------------
//  Utilidades
// ---------------------------------------------------------------------------

/** Código de violação de restrição UNIQUE no Postgres via Prisma. */
export const UNIQUE_VIOLATION = 'P2002';
export const FOREIGN_KEY_VIOLATION = 'P2003';
export const RECORD_NOT_FOUND = 'P2025';

export function isUniqueViolation(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION
  );
}

/**
 * Alvos da violação UNIQUE, para distinguir "já existe um destino para esta
 * conta" (idempotência funcionando) de outra colisão qualquer.
 */
export function uniqueViolationTargets(error: unknown): string[] {
  if (!isUniqueViolation(error)) return [];
  const target = error.meta?.['target'];
  if (Array.isArray(target)) return target.map(String);
  if (typeof target === 'string') return [target];
  return [];
}
