import type { PlatformKey } from '../platform/capabilities.js';

/**
 * Circuit breaker por plataforma (SPEC seção 12).
 *
 * Se o TikTok cai, não adianta 200 workers martelarem a API dele: gasta
 * tentativa, aumenta o rate limit e atrasa as redes que estão de pé. O
 * circuito abre, o sistema para de tentar por um tempo e isso fica visível
 * no painel.
 *
 * A máquina de estados é pura; o estado é persistido em `SocialPlatform` para
 * ser compartilhado entre os processos de worker — um breaker em memória por
 * processo abriria e fecharia de forma independente em cada réplica, que é
 * justamente o que não se quer com API externa.
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitConfig {
  /** Falhas consecutivas para abrir. */
  failureThreshold: number;
  /** Tempo com o circuito aberto antes de tentar uma sondagem. */
  openDurationMs: number;
  /** Sucessos em HALF_OPEN para fechar de novo. */
  successThreshold: number;
}

export const DEFAULT_CIRCUIT_CONFIG: CircuitConfig = {
  failureThreshold: 5,
  openDurationMs: 5 * 60_000,
  successThreshold: 2,
};

export interface CircuitSnapshot {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  openedAt: Date | null;
  halfOpenAt: Date | null;
}

export interface CircuitDecision {
  allowed: boolean;
  /** Quando `allowed` é false, em quanto tempo tentar de novo. */
  retryAfterMs: number;
  /** Estado depois da decisão (pode transitar OPEN -> HALF_OPEN). */
  next: CircuitSnapshot;
}

export function initialCircuit(): CircuitSnapshot {
  return { state: 'CLOSED', failureCount: 0, successCount: 0, openedAt: null, halfOpenAt: null };
}

/** A chamada pode passar agora? */
export function canAttempt(
  snapshot: CircuitSnapshot,
  now: Date,
  config: CircuitConfig = DEFAULT_CIRCUIT_CONFIG,
): CircuitDecision {
  if (snapshot.state === 'CLOSED') {
    return { allowed: true, retryAfterMs: 0, next: snapshot };
  }

  if (snapshot.state === 'HALF_OPEN') {
    // Em HALF_OPEN deixamos passar: é a sondagem que decide se a plataforma
    // voltou. O limite de concorrência dessa sondagem é do worker.
    return { allowed: true, retryAfterMs: 0, next: snapshot };
  }

  const openedAt = snapshot.openedAt?.getTime() ?? now.getTime();
  const elapsed = now.getTime() - openedAt;

  if (elapsed >= config.openDurationMs) {
    return {
      allowed: true,
      retryAfterMs: 0,
      next: { ...snapshot, state: 'HALF_OPEN', successCount: 0, halfOpenAt: now },
    };
  }

  return {
    allowed: false,
    retryAfterMs: config.openDurationMs - elapsed,
    next: snapshot,
  };
}

export function recordSuccess(
  snapshot: CircuitSnapshot,
  config: CircuitConfig = DEFAULT_CIRCUIT_CONFIG,
): CircuitSnapshot {
  if (snapshot.state === 'HALF_OPEN') {
    const successCount = snapshot.successCount + 1;
    if (successCount >= config.successThreshold) return initialCircuit();
    return { ...snapshot, successCount };
  }
  return { ...snapshot, failureCount: 0, successCount: 0 };
}

export function recordFailure(
  snapshot: CircuitSnapshot,
  now: Date,
  config: CircuitConfig = DEFAULT_CIRCUIT_CONFIG,
): CircuitSnapshot {
  // Uma falha durante a sondagem reabre imediatamente: a plataforma ainda
  // não voltou, e insistir só repete o problema.
  if (snapshot.state === 'HALF_OPEN') {
    return {
      state: 'OPEN',
      failureCount: snapshot.failureCount + 1,
      successCount: 0,
      openedAt: now,
      halfOpenAt: null,
    };
  }

  const failureCount = snapshot.failureCount + 1;
  if (failureCount >= config.failureThreshold) {
    return { state: 'OPEN', failureCount, successCount: 0, openedAt: now, halfOpenAt: null };
  }

  return { ...snapshot, failureCount };
}

export interface CircuitStore {
  load(platform: PlatformKey): Promise<CircuitSnapshot>;
  save(platform: PlatformKey, snapshot: CircuitSnapshot): Promise<void>;
}
