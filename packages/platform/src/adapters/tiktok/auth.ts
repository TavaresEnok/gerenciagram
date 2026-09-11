import {
  PlatformApiError,
  TokenExpiredError,
  withTimeout,
  type AdapterContext,
  type AppCredentials,
  type AuthorizationUrlParams,
  type OAuthCallbackParams,
  type PlatformCredentials,
  type RemoteAccountIdentity,
  type SocialAuthenticator,
  type TokenExchangeResult,
} from '@app/core';
import { tiktokRequest } from './http.js';

/**
 * OAuth 2.0 do TikTok (Login Kit v2).
 *
 * Fonte oficial consultada em 2026-09-11:
 *   https://developers.tiktok.com/doc/oauth-user-access-token-management
 *
 * Três diferenças em relação ao Google que quebram em silêncio se alguém
 * copiar o adapter do YouTube:
 *
 *  1. o parâmetro do aplicativo chama-se `client_key`, NÃO `client_id`. Com o
 *     nome errado o TikTok responde um erro genérico de parâmetro.
 *  2. o access token dura 24h e o REFRESH token também expira
 *     (`refresh_expires_in`, 365 dias por padrão). Diferente do Google, onde
 *     o refresh token é perpétuo — aqui a conta morre de vez se ninguém
 *     renovar dentro da janela, e o usuário precisa reconectar.
 *  3. o refresh devolve um refresh token NOVO a cada chamada, e o antigo
 *     deixa de valer. Guardar o antigo (como se faz no Google) derruba a
 *     conta na renovação seguinte.
 *
 * O redirect URI precisa ser HTTPS público: o TikTok recusa `http://localhost`
 * no cadastro do app (ver SOCIAL_INTEGRATIONS.md).
 */

const AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const REVOKE_URL = 'https://open.tiktokapis.com/v2/oauth/revoke/';

const PLATFORM = 'TikTok';

/** Campos de perfil que o escopo `user.info.basic` libera. */
const USER_FIELDS = 'open_id,union_id,avatar_url,display_name';

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  open_id?: string;
  refresh_expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

interface UserInfoResponse {
  data?: {
    user?: {
      open_id?: string;
      union_id?: string;
      avatar_url?: string;
      display_name?: string;
    };
  };
}

export function createTikTokAuthenticator(): SocialAuthenticator {
  return {
    buildAuthorizationUrl(app: AppCredentials, params: AuthorizationUrlParams): string {
      const url = new URL(AUTHORIZE_URL);
      url.searchParams.set('client_key', app.clientId);
      url.searchParams.set('redirect_uri', app.redirectUri);
      url.searchParams.set('response_type', 'code');
      // O TikTok separa escopos por vírgula.
      url.searchParams.set('scope', params.scopes.join(','));
      url.searchParams.set('state', params.state);

      if (params.codeChallenge) {
        url.searchParams.set('code_challenge', params.codeChallenge);
        url.searchParams.set('code_challenge_method', 'S256');
      }

      return url.toString();
    },

    async exchangeCodeForTokens(
      app: AppCredentials,
      params: OAuthCallbackParams,
      ctx: AdapterContext,
    ): Promise<TokenExchangeResult> {
      const body = new URLSearchParams({
        client_key: app.clientId,
        client_secret: app.clientSecret,
        code: params.code,
        grant_type: 'authorization_code',
        redirect_uri: app.redirectUri,
      });
      if (params.codeVerifier) body.set('code_verifier', params.codeVerifier);

      const token = await postForm(body, ctx);
      const credentials = toCredentials(token);

      const identity = await fetchUserIdentity(credentials, ctx, token.open_id);
      return { credentials, identity };
    },

    async refreshCredentials(
      app: AppCredentials,
      credentials: PlatformCredentials,
      ctx: AdapterContext,
    ): Promise<PlatformCredentials> {
      if (!credentials.refreshToken) {
        throw new TokenExpiredError(
          PLATFORM,
          'Esta conta do TikTok não tem refresh token guardado. É preciso reconectar.',
        );
      }

      const body = new URLSearchParams({
        client_key: app.clientId,
        client_secret: app.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: credentials.refreshToken,
      });

      let token: TokenResponse;
      try {
        token = await postForm(body, ctx);
      } catch (erro) {
        if (erro instanceof PlatformApiError && /invalid_grant|invalid_request/i.test(erro.message)) {
          throw new TokenExpiredError(
            PLATFORM,
            'O refresh token do TikTok expirou ou foi revogado. Reconecte a conta.',
          );
        }
        throw erro;
      }

      // O TikTok rotaciona o refresh token: o valor devolvido substitui o
      // anterior, que deixa de funcionar. Cair no antigo quebraria a próxima
      // renovação.
      return toCredentials(token, credentials);
    },

    async revoke(
      app: AppCredentials,
      credentials: PlatformCredentials,
      ctx: AdapterContext,
    ): Promise<void> {
      const body = new URLSearchParams({
        client_key: app.clientId,
        client_secret: app.clientSecret,
        token: credentials.accessToken,
      });

      try {
        await postForm(body, ctx, REVOKE_URL);
      } catch (erro) {
        // Token já inválido: do ponto de vista da LGPD o objetivo — não haver
        // mais autorização nossa na conta — já está atingido.
        if (erro instanceof PlatformApiError && !erro.retryable) return;
        throw erro;
      }
    },

    async fetchIdentity(
      credentials: PlatformCredentials,
      ctx: AdapterContext,
    ): Promise<RemoteAccountIdentity> {
      return fetchUserIdentity(credentials, ctx);
    },
  };
}

// ---------------------------------------------------------------------------

function toCredentials(
  token: TokenResponse,
  anterior?: PlatformCredentials,
): PlatformCredentials {
  if (!token.access_token) {
    throw new PlatformApiError(
      `O TikTok não devolveu um access token: ${token.error_description ?? token.error ?? 'resposta vazia'}`,
      { retryable: false, platform: PLATFORM },
    );
  }

  const credentials: PlatformCredentials = {
    accessToken: token.access_token,
    scopes: token.scope?.split(',').map((s) => s.trim()).filter(Boolean) ?? anterior?.scopes ?? [],
  };

  if (token.refresh_token) credentials.refreshToken = token.refresh_token;
  if (typeof token.expires_in === 'number') {
    credentials.expiresAt = new Date(Date.now() + token.expires_in * 1000);
  }

  return credentials;
}

async function fetchUserIdentity(
  credentials: PlatformCredentials,
  ctx: AdapterContext,
  openIdDoToken?: string,
): Promise<RemoteAccountIdentity> {
  const resposta = await tiktokRequest<UserInfoResponse>({
    path: '/v2/user/info/',
    method: 'GET',
    query: { fields: USER_FIELDS },
    accessToken: credentials.accessToken,
    ctx,
  });

  const user = resposta.data?.user;
  const remoteId = user?.open_id ?? openIdDoToken;

  if (!remoteId) {
    throw new PlatformApiError(
      'O TikTok não devolveu o open_id da conta. Sem ele não há como identificar o destino.',
      { retryable: false, platform: PLATFORM },
    );
  }

  const identity: RemoteAccountIdentity = { remoteId };

  if (user?.display_name) identity.displayName = user.display_name;
  if (user?.avatar_url) identity.avatarUrl = user.avatar_url;
  // union_id identifica o mesmo usuário entre apps do mesmo developer; é útil
  // para diagnóstico e não substitui o open_id.
  if (user?.union_id) identity.metadata = { unionId: user.union_id };

  return identity;
}

/**
 * Os endpoints de token e de revogação do TikTok usam form-urlencoded e NÃO
 * aceitam o header Authorization — as credenciais do app vão no corpo.
 */
async function postForm(
  body: URLSearchParams,
  ctx: AdapterContext,
  url: string = TOKEN_URL,
): Promise<TokenResponse> {
  const { signal, cancel } = withTimeout(ctx.timeoutMs, ctx.signal);

  try {
    const resposta = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cache-Control': 'no-cache',
      },
      body: body.toString(),
      signal,
    });

    const texto = await resposta.text();
    const payload = (texto ? JSON.parse(texto) : {}) as TokenResponse;

    // Também aqui o TikTok devolve 200 com `error` preenchido.
    if (!resposta.ok || (payload.error && payload.error !== 'ok')) {
      throw new PlatformApiError(
        `OAuth do TikTok (${payload.error ?? resposta.status}): ${payload.error_description ?? texto.slice(0, 300)}`,
        {
          retryable: resposta.status >= 500,
          platform: PLATFORM,
          httpStatus: resposta.status,
        },
      );
    }

    return payload;
  } catch (erro) {
    if (erro instanceof PlatformApiError) throw erro;
    if (erro instanceof Error && (erro.name === 'AbortError' || erro.name === 'TimeoutError')) {
      throw new PlatformApiError(`Tempo esgotado no OAuth do TikTok (${ctx.timeoutMs}ms)`, {
        retryable: true,
        platform: PLATFORM,
      });
    }
    throw new PlatformApiError(
      `Falha ao falar com o OAuth do TikTok: ${erro instanceof Error ? erro.message : String(erro)}`,
      { retryable: true, platform: PLATFORM, cause: erro },
    );
  } finally {
    cancel();
  }
}
