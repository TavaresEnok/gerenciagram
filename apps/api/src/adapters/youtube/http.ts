import {
  PlatformApiError,
  PlatformTimeoutError,
  RateLimitError,
  TokenExpiredError,
  withTimeout,
  type AdapterContext,
} from '@app/core';

/**
 * Camada HTTP do adapter do YouTube.
 *
 * Duas responsabilidades, ambas exigidas pela SPEC seção 12:
 *  1. toda chamada tem timeout explícito;
 *  2. todo erro sai classificado como recuperável ou permanente — é isso que
 *     o worker usa para decidir entre re-tentar e desistir.
 */

const PLATFORM = 'YouTube';

export interface GoogleApiError {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: Array<{ reason?: string; message?: string; domain?: string }>;
  };
}

/**
 * Motivos de erro do Google que NÃO adianta re-tentar.
 * Fonte: https://developers.google.com/youtube/v3/docs/errors
 */
const PERMANENT_REASONS = new Set([
  'invalidTitle',
  'invalidDescription',
  'invalidCategoryId',
  'invalidVideoMetadata',
  'invalidFilename',
  'mediaBodyRequired',
  'forbiddenLicenseSetting',
  'forbiddenPrivacySetting',
  'invalidRecordingDetails',
  'defaultLanguageNotSet',
  'invalidTags',
  'failedPrecondition',
  'youtubeSignupRequired',
  'unsupportedVideoFormat',
  'videoTypeUnsupported',
  'authorizationRequired',
  'insufficientPermissions',
  'forbidden',
]);

/** Motivos de cota — recuperáveis, mas só depois do reset da janela. */
const QUOTA_REASONS = new Set([
  'quotaExceeded',
  'dailyLimitExceeded',
  'userRateLimitExceeded',
  'rateLimitExceeded',
  'uploadLimitExceeded',
]);

export interface RequestOptions {
  method?: string;
  url: string;
  accessToken: string;
  body?: unknown;
  headers?: Record<string, string>;
  ctx: AdapterContext;
  /** Não interpretar a resposta como JSON (upload de bytes). */
  raw?: boolean;
}

export async function googleRequest<T>(options: RequestOptions): Promise<T> {
  const response = await rawGoogleRequest(options);

  if (options.raw) return response as unknown as T;

  const text = await response.text();
  if (!text) return undefined as unknown as T;

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new PlatformApiError('Resposta do YouTube não é JSON válido', {
      retryable: true,
      platform: PLATFORM,
      httpStatus: response.status,
    });
  }
}

export async function rawGoogleRequest(options: RequestOptions): Promise<Response> {
  const { signal, cancel } = withTimeout(options.ctx.timeoutMs, options.ctx.signal);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.accessToken}`,
    Accept: 'application/json',
    ...options.headers,
  };

  let body: string | Uint8Array | undefined;
  if (options.body !== undefined) {
    if (typeof options.body === 'string' || options.body instanceof Uint8Array) {
      body = options.body;
    } else {
      headers['Content-Type'] ??= 'application/json; charset=UTF-8';
      body = JSON.stringify(options.body);
    }
  }

  try {
    const response = await fetch(options.url, {
      method: options.method ?? 'GET',
      headers,
      ...(body !== undefined ? { body } : {}),
      signal,
    });

    if (!response.ok && response.status !== 308) {
      throw await toDomainError(response);
    }

    return response;
  } catch (error) {
    if (error instanceof PlatformApiError || error instanceof RateLimitError) throw error;

    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw new PlatformTimeoutError(PLATFORM, options.ctx.timeoutMs);
    }

    throw new PlatformApiError(
      `Falha de rede ao chamar a API do YouTube: ${error instanceof Error ? error.message : String(error)}`,
      { retryable: true, platform: PLATFORM, cause: error },
    );
  } finally {
    cancel();
  }
}

/**
 * Traduz a resposta de erro do Google para o erro de domínio correspondente.
 * A classificação retryable/permanente é o que impede o worker de queimar
 * 5 tentativas contra um título inválido, ou de desistir de um 503 passageiro.
 */
async function toDomainError(response: Response): Promise<Error> {
  let payload: GoogleApiError = {};
  let snippet = '';

  try {
    snippet = await response.text();
    payload = JSON.parse(snippet) as GoogleApiError;
  } catch {
    // Resposta sem corpo JSON: seguimos só com o status.
  }

  const reason = payload.error?.errors?.[0]?.reason ?? '';
  const message =
    payload.error?.message ?? snippet.slice(0, 300) ?? `HTTP ${response.status}`;

  if (response.status === 401) {
    return new TokenExpiredError(
      PLATFORM,
      `O YouTube recusou o token de acesso desta conta: ${message}`,
    );
  }

  if (QUOTA_REASONS.has(reason)) {
    const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
    return new RateLimitError(
      `Cota do YouTube atingida (${reason}): ${message}`,
      retryAfter ?? 60 * 60_000,
    );
  }

  if (response.status === 429) {
    const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
    return new RateLimitError(`YouTube: ${message}`, retryAfter ?? 60_000);
  }

  if (response.status === 403 && PERMANENT_REASONS.has(reason)) {
    return new PlatformApiError(`YouTube (${reason}): ${message}`, {
      retryable: false,
      platform: PLATFORM,
      httpStatus: response.status,
      remoteCode: reason,
    });
  }

  if (response.status >= 500) {
    return new PlatformApiError(`YouTube indisponível (${response.status}): ${message}`, {
      retryable: true,
      platform: PLATFORM,
      httpStatus: response.status,
      remoteCode: reason,
    });
  }

  const retryable = response.status >= 400 && response.status < 500
    ? !PERMANENT_REASONS.has(reason) && response.status !== 400
    : true;

  return new PlatformApiError(`YouTube (${response.status}${reason ? `/${reason}` : ''}): ${message}`, {
    retryable,
    platform: PLATFORM,
    httpStatus: response.status,
    remoteCode: reason,
  });
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}
