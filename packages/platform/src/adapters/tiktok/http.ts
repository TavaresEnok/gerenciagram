import {
  PlatformApiError,
  PlatformTimeoutError,
  RateLimitError,
  TokenExpiredError,
  withTimeout,
  type AdapterContext,
} from '@app/core';

/**
 * Camada HTTP da API do TikTok.
 *
 * O TikTok responde **200 mesmo em erro**: o que indica falha é o campo
 * `error.code` no corpo, que vale `"ok"` quando deu certo. Tratar só o status
 * HTTP deixaria passar erro como sucesso — e a publicação apareceria como
 * concluída sem ter acontecido.
 */

const PLATFORM = 'TikTok';
const HOST = 'https://open.tiktokapis.com';

export interface TikTokError {
  error?: {
    code?: string;
    message?: string;
    log_id?: string;
  };
}

/** Códigos que NÃO adiantam re-tentar. */
const PERMANENTES = new Set([
  'invalid_param',
  'spam_risk_too_many_posts',
  'spam_risk_user_banned_from_posting',
  'reached_active_user_cap',
  'unaudited_client_can_only_post_to_private_accounts',
  'url_ownership_unverified',
  'privacy_level_option_mismatch',
  'file_format_check_failed',
  'duration_check_failed',
  'frame_rate_check_failed',
  'picture_size_check_failed',
  'video_pull_failed',
]);

const LIMITES = new Set(['rate_limit_exceeded', 'spam_risk_too_many_posts']);

const TOKEN_INVALIDO = new Set([
  'access_token_invalid',
  'scope_not_authorized',
  'scope_permission_missed',
]);

export interface TikTokRequestOptions {
  /** Caminho a partir do host, ex.: `/v2/post/publish/video/init/`. */
  path: string;
  accessToken: string;
  /** Publicação é sempre POST; leitura de perfil e de métricas é GET. */
  method?: 'GET' | 'POST';
  /** Querystring — os endpoints de leitura do TikTok exigem `fields=`. */
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  ctx: AdapterContext;
}

export async function tiktokRequest<T>(options: TikTokRequestOptions): Promise<T> {
  const { signal, cancel } = withTimeout(options.ctx.timeoutMs, options.ctx.signal);

  const url = new URL(`${HOST}${options.path}`);
  for (const [chave, valor] of Object.entries(options.query ?? {})) {
    url.searchParams.set(chave, valor);
  }

  try {
    const resposta = await fetch(url.toString(), {
      method: options.method ?? 'POST',
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal,
    });

    const texto = await resposta.text();
    const payload = (texto ? JSON.parse(texto) : {}) as TikTokError & { data?: unknown };

    // O TikTok sinaliza erro NO CORPO, com HTTP 200. Checar o status sozinho
    // deixaria passar falha como sucesso.
    const codigo = payload.error?.code;

    if (!resposta.ok || (codigo && codigo !== 'ok')) {
      throw toDomainError(resposta.status, payload);
    }

    return payload as T;
  } catch (erro) {
    if (erro instanceof PlatformApiError || erro instanceof RateLimitError) throw erro;

    if (erro instanceof Error && (erro.name === 'AbortError' || erro.name === 'TimeoutError')) {
      throw new PlatformTimeoutError(PLATFORM, options.ctx.timeoutMs);
    }

    throw new PlatformApiError(
      `Falha de rede ao chamar a API do TikTok: ${erro instanceof Error ? erro.message : String(erro)}`,
      { retryable: true, platform: PLATFORM, cause: erro },
    );
  } finally {
    cancel();
  }
}

function toDomainError(status: number, payload: TikTokError): Error {
  const codigo = payload.error?.code ?? '';
  const mensagem = payload.error?.message ?? `HTTP ${status}`;

  if (TOKEN_INVALIDO.has(codigo) || status === 401) {
    return new TokenExpiredError(
      PLATFORM,
      `O TikTok recusou o token desta conta: ${mensagem}. É preciso reconectar.`,
    );
  }

  if (LIMITES.has(codigo) || status === 429) {
    return new RateLimitError(`Limite do TikTok atingido (${codigo}): ${mensagem}`, 3_600_000);
  }

  if (codigo === 'unaudited_client_can_only_post_to_private_accounts') {
    return new PlatformApiError(
      'O aplicativo ainda não passou pela auditoria do TikTok, então só publica em contas ' +
        'privadas e como SELF_ONLY. Solicite a auditoria para liberar a publicação pública.',
      { retryable: false, platform: PLATFORM, remoteCode: codigo },
    );
  }

  if (PERMANENTES.has(codigo)) {
    return new PlatformApiError(`TikTok (${codigo}): ${mensagem}`, {
      retryable: false,
      platform: PLATFORM,
      httpStatus: status,
      remoteCode: codigo,
    });
  }

  return new PlatformApiError(`TikTok (${codigo || status}): ${mensagem}`, {
    retryable: status >= 500 || codigo === 'internal_error',
    platform: PLATFORM,
    httpStatus: status,
    ...(codigo ? { remoteCode: codigo } : {}),
  });
}
