import {
  PlatformApiError,
  PlatformTimeoutError,
  RateLimitError,
  TokenExpiredError,
  withTimeout,
  type AdapterContext,
} from '@app/core';

/**
 * Camada HTTP da API v2 do X (Twitter).
 *
 * Mapeia rate limits (cabeçalhos x-rate-limit-*), expiração de tokens e
 * erros da API v2 para as classes de erro de domínio do sistema.
 */

const PLATFORM = 'X';
const HOST = 'https://api.x.com';

export interface XErrorResponse {
  title?: string;
  detail?: string;
  type?: string;
  status?: number;
  errors?: Array<{
    message?: string;
    parameters?: Record<string, unknown>;
  }>;
}

export interface XRequestOptions {
  path: string;
  accessToken: string;
  method?: 'GET' | 'POST' | 'DELETE' | 'PUT';
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  customHeaders?: Record<string, string>;
  ctx: AdapterContext;
}

export async function xRequest<T>(options: XRequestOptions): Promise<T> {
  const { signal, cancel } = withTimeout(options.ctx.timeoutMs, options.ctx.signal);

  const url = new URL(options.path.startsWith('http') ? options.path : `${HOST}${options.path}`);
  for (const [chave, valor] of Object.entries(options.query ?? {})) {
    url.searchParams.set(chave, valor);
  }

  try {
    const resposta = await fetch(url.toString(), {
      method: options.method ?? 'POST',
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        ...(options.body ? { 'Content-Type': 'application/json; charset=UTF-8' } : {}),
        ...options.customHeaders,
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal,
    });

    // Tratamento de Rate Limit do X
    if (resposta.status === 429) {
      const resetEpochSec = Number(resposta.headers.get('x-rate-limit-reset'));
      const retryAfterMs = Number.isFinite(resetEpochSec) && resetEpochSec > 0
        ? Math.max(1000, resetEpochSec * 1000 - Date.now())
        : 60_000;

      throw new RateLimitError(
        'Limite de requisições da API do X atingido. Aguarde a renovação da cota.',
        retryAfterMs,
      );
    }

    if (resposta.status === 401) {
      throw new TokenExpiredError(
        PLATFORM,
        'Token de acesso do X expirado ou revogado. É necessária a renovação ou reconexão.',
      );
    }

    if (resposta.status === 204) {
      return {} as T;
    }

    const texto = await resposta.text();
    const payload = (texto ? JSON.parse(texto) : {}) as XErrorResponse & T;

    if (!resposta.ok) {
      const detalhe = payload.detail ?? payload.title ?? payload.errors?.[0]?.message ?? `HTTP ${resposta.status}`;
      const ehPermanente = resposta.status >= 400 && resposta.status < 500;

      throw new PlatformApiError(`Falha na chamada à API do X: ${detalhe}`, {
        platform: PLATFORM,
        httpStatus: resposta.status,
        retryable: !ehPermanente,
      });
    }

    return payload as T;
  } catch (erro) {
    if (erro instanceof PlatformApiError || erro instanceof RateLimitError) throw erro;

    if (erro instanceof Error && (erro.name === 'AbortError' || erro.name === 'TimeoutError')) {
      throw new PlatformTimeoutError(PLATFORM, options.ctx.timeoutMs);
    }

    throw new PlatformApiError(
      `Falha de rede ao conectar à API do X: ${erro instanceof Error ? erro.message : String(erro)}`,
      { platform: PLATFORM, retryable: true, cause: erro },
    );
  } finally {
    cancel();
  }
}
