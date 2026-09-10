import {
  CircuitOpenError,
  DEFAULT_CIRCUIT_CONFIG,
  canAttempt,
  recordFailure,
  recordSuccess,
  type CircuitConfig,
  type CircuitSnapshot,
  type CircuitStore,
  type PlatformKey,
} from '@app/core';
import type { PrismaClient } from '@app/db';

/**
 * Circuit breaker persistido em `SocialPlatform` (SPEC seção 12).
 *
 * O estado vive no BANCO, não em memória, porque o worker escala
 * horizontalmente: um breaker por processo abriria e fecharia de forma
 * independente em cada réplica, e vinte réplicas continuariam martelando uma
 * plataforma fora do ar — exatamente o que o breaker existe para impedir.
 */

export function createCircuitStore(prisma: PrismaClient): CircuitStore {
  return {
    async load(platform: PlatformKey): Promise<CircuitSnapshot> {
      const row = await prisma.socialPlatform.findUnique({
        where: { key: platform },
        select: {
          circuitState: true,
          circuitFailureCount: true,
          circuitOpenedAt: true,
          circuitHalfOpenAt: true,
        },
      });

      if (!row) {
        return {
          state: 'CLOSED',
          failureCount: 0,
          successCount: 0,
          openedAt: null,
          halfOpenAt: null,
        };
      }

      return {
        state: row.circuitState,
        failureCount: row.circuitFailureCount,
        // successCount não é persistido: só importa dentro de uma janela de
        // sondagem, e mantê-lo no banco criaria contenção de escrita a cada
        // publicação bem-sucedida.
        successCount: 0,
        openedAt: row.circuitOpenedAt,
        halfOpenAt: row.circuitHalfOpenAt,
      };
    },

    async save(platform: PlatformKey, snapshot: CircuitSnapshot): Promise<void> {
      await prisma.socialPlatform.update({
        where: { key: platform },
        data: {
          circuitState: snapshot.state,
          circuitFailureCount: snapshot.failureCount,
          circuitOpenedAt: snapshot.openedAt,
          circuitHalfOpenAt: snapshot.halfOpenAt,
        },
      });
    },
  };
}

export interface CircuitGuard {
  /** Lança `CircuitOpenError` quando a plataforma está suspensa. */
  assertClosed(platform: PlatformKey, now?: Date): Promise<void>;
  onSuccess(platform: PlatformKey): Promise<void>;
  onFailure(platform: PlatformKey, now?: Date): Promise<void>;
}

export function createCircuitGuard(
  store: CircuitStore,
  config: CircuitConfig = DEFAULT_CIRCUIT_CONFIG,
): CircuitGuard {
  return {
    async assertClosed(platform, now = new Date()) {
      const snapshot = await store.load(platform);
      const decision = canAttempt(snapshot, now, config);

      if (decision.next !== snapshot) {
        await store.save(platform, decision.next);
      }

      if (!decision.allowed) {
        throw new CircuitOpenError(platform, decision.retryAfterMs);
      }
    },

    async onSuccess(platform) {
      const snapshot = await store.load(platform);
      // Circuito já fechado e sem falhas acumuladas: nada a gravar. Evita uma
      // escrita no banco a cada publicação bem-sucedida.
      if (snapshot.state === 'CLOSED' && snapshot.failureCount === 0) return;

      await store.save(platform, recordSuccess(snapshot, config));
    },

    async onFailure(platform, now = new Date()) {
      const snapshot = await store.load(platform);
      await store.save(platform, recordFailure(snapshot, now, config));
    },
  };
}
