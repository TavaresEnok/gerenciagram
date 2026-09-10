import { isRetryable, RateLimitError, PlatformApiError } from '../errors.js';

/**
 * Retry com backoff exponencial + jitter (SPEC seção 12).
 *
 * O jitter não é enfeite: sem ele, 20 destinos que falham juntos porque a
 * plataforma caiu voltam todos ao mesmo tempo e derrubam de novo. O jitter
 * "full" (aleatório entre 0 e o teto) é o que melhor espalha essa manada.
 */

export interface BackoffOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  factor: number;
  /** 0 = sem jitter, 1 = jitter total. */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  baseDelayMs: 30_000,
  maxDelayMs: 3_600_000, // 1h
  factor: 3,
  jitter: 1,
};

export function computeBackoffDelay(
  attempt: number,
  options: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const exponential = options.baseDelayMs * options.factor ** Math.max(0, attempt - 1);
  const capped = Math.min(exponential, options.maxDelayMs);
  if (options.jitter <= 0) return Math.round(capped);

  const jittered = capped * (1 - options.jitter) + capped * options.jitter * random();
  return Math.round(jittered);
}

/**
 * Quando a plataforma diz explicitamente quando voltar (`Retry-After`),
 * respeitamos — bater antes só queima tentativa.
 */
export function nextRetryDelay(
  error: unknown,
  attempt: number,
  options: BackoffOptions = DEFAULT_BACKOFF,
): number | null {
  if (!isRetryable(error)) return null;

  if (error instanceof RateLimitError) {
    return Math.min(error.retryAfterMs, options.maxDelayMs);
  }
  if (error instanceof PlatformApiError && error.retryAfterMs !== undefined) {
    return Math.min(error.retryAfterMs, options.maxDelayMs);
  }

  return computeBackoffDelay(attempt, options);
}

/**
 * Timeout explícito em toda chamada externa (SPEC seção 12). Devolve um
 * AbortSignal já combinado com o signal do chamador, para que o shutdown do
 * worker também cancele a requisição em voo.
 */
export function withTimeout(
  timeoutMs: number,
  parentSignal?: AbortSignal,
): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);

  const onParentAbort = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener('abort', onParentAbort, { once: true });

  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onParentAbort);
    },
  };
}
