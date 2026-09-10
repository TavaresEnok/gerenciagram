import { describe, expect, it } from 'vitest';
import {
  canAttempt,
  DEFAULT_CIRCUIT_CONFIG,
  initialCircuit,
  recordFailure,
  recordSuccess,
} from './circuit-breaker.js';
import { computeBackoffDelay, DEFAULT_BACKOFF, nextRetryDelay, withTimeout } from './retry.js';
import {
  PlatformApiError,
  PlatformTimeoutError,
  RateLimitError,
  TokenExpiredError,
  isRetryable,
} from '../errors.js';

describe('classificação de erro', () => {
  it('timeout é recuperável', () => {
    expect(isRetryable(new PlatformTimeoutError('YouTube', 30_000))).toBe(true);
  });

  it('token expirado NÃO é recuperável — re-tentar só queima tentativa', () => {
    expect(isRetryable(new TokenExpiredError('YouTube'))).toBe(false);
  });

  it('rate limit é recuperável', () => {
    expect(isRetryable(new RateLimitError())).toBe(true);
  });

  it('erro de rede do Node é recuperável', () => {
    const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    expect(isRetryable(err)).toBe(true);
  });
});

describe('backoff exponencial', () => {
  it('cresce exponencialmente', () => {
    const noJitter = { ...DEFAULT_BACKOFF, jitter: 0 };
    expect(computeBackoffDelay(1, noJitter)).toBe(30_000);
    expect(computeBackoffDelay(2, noJitter)).toBe(90_000);
    expect(computeBackoffDelay(3, noJitter)).toBe(270_000);
  });

  it('respeita o teto', () => {
    const noJitter = { ...DEFAULT_BACKOFF, jitter: 0 };
    expect(computeBackoffDelay(20, noJitter)).toBe(DEFAULT_BACKOFF.maxDelayMs);
  });

  it('o jitter espalha o retorno da manada', () => {
    // Sem jitter, 20 destinos que falham juntos voltam no mesmo milissegundo.
    const delays = new Set(
      Array.from({ length: 20 }, () => computeBackoffDelay(3, DEFAULT_BACKOFF)),
    );
    expect(delays.size).toBeGreaterThan(1);
  });

  it('respeita Retry-After da plataforma em vez do backoff calculado', () => {
    const error = new PlatformApiError('devagar', {
      retryable: true,
      platform: 'YouTube',
      retryAfterMs: 5_000,
    });
    expect(nextRetryDelay(error, 5)).toBe(5_000);
  });

  it('devolve null para erro permanente', () => {
    expect(nextRetryDelay(new TokenExpiredError('YouTube'), 1)).toBeNull();
  });
});

describe('circuit breaker', () => {
  const now = new Date('2026-09-10T12:00:00.000Z');

  it('abre depois do limite de falhas consecutivas', () => {
    let circuit = initialCircuit();
    for (let i = 0; i < DEFAULT_CIRCUIT_CONFIG.failureThreshold; i += 1) {
      circuit = recordFailure(circuit, now);
    }
    expect(circuit.state).toBe('OPEN');
    expect(canAttempt(circuit, now).allowed).toBe(false);
  });

  it('um sucesso zera a contagem antes de abrir', () => {
    let circuit = initialCircuit();
    circuit = recordFailure(circuit, now);
    circuit = recordFailure(circuit, now);
    circuit = recordSuccess(circuit);
    expect(circuit.failureCount).toBe(0);
    expect(circuit.state).toBe('CLOSED');
  });

  it('passa para HALF_OPEN depois da janela e deixa a sondagem passar', () => {
    let circuit = initialCircuit();
    for (let i = 0; i < DEFAULT_CIRCUIT_CONFIG.failureThreshold; i += 1) {
      circuit = recordFailure(circuit, now);
    }

    const later = new Date(now.getTime() + DEFAULT_CIRCUIT_CONFIG.openDurationMs + 1);
    const decision = canAttempt(circuit, later);

    expect(decision.allowed).toBe(true);
    expect(decision.next.state).toBe('HALF_OPEN');
  });

  it('falha na sondagem reabre imediatamente', () => {
    const halfOpen = { ...initialCircuit(), state: 'HALF_OPEN' as const };
    const circuit = recordFailure(halfOpen, now);
    expect(circuit.state).toBe('OPEN');
    expect(circuit.openedAt).toEqual(now);
  });

  it('sucessos suficientes em HALF_OPEN fecham o circuito', () => {
    let circuit = { ...initialCircuit(), state: 'HALF_OPEN' as const };
    for (let i = 0; i < DEFAULT_CIRCUIT_CONFIG.successThreshold; i += 1) {
      circuit = recordSuccess(circuit);
    }
    expect(circuit.state).toBe('CLOSED');
  });

  it('informa em quanto tempo tentar de novo enquanto está aberto', () => {
    let circuit = initialCircuit();
    for (let i = 0; i < DEFAULT_CIRCUIT_CONFIG.failureThreshold; i += 1) {
      circuit = recordFailure(circuit, now);
    }
    const decision = canAttempt(circuit, new Date(now.getTime() + 60_000));
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterMs).toBe(DEFAULT_CIRCUIT_CONFIG.openDurationMs - 60_000);
  });
});

describe('timeout de chamada externa', () => {
  it('aborta sozinho depois do prazo', async () => {
    const { signal, cancel } = withTimeout(20);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(signal.aborted).toBe(true);
    cancel();
  });

  it('o cancelamento do chamador propaga para a requisição em voo', () => {
    const parent = new AbortController();
    const { signal, cancel } = withTimeout(60_000, parent.signal);
    parent.abort(new Error('shutdown do worker'));
    expect(signal.aborted).toBe(true);
    cancel();
  });
});
