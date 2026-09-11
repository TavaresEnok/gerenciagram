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
import { xRequest } from './http.js';

/**
 * Autenticador OAuth 2.0 com PKCE para o X (Twitter).
 *
 * Fontes oficiais:
 *   https://docs.x.com/x-api/authentication/oauth-2-0/authorization-code-flow-with-pkce
 *   https://docs.x.com/x-api/users/lookup/api-reference/get-users-me
 */

const AUTHORIZE_URL = 'https://twitter.com/i/oauth2/authorize';
const TOKEN_URL = 'https://api.x.com/2/oauth2/token';
const REVOKE_URL = 'https://api.x.com/2/oauth2/revoke';
const PLATFORM = 'X';

interface OAuthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface UserMeResponse {
  data?: {
    id?: string;
    name?: string;
    username?: string;
    profile_image_url?: string;
  };
}

export function createXAuthenticator(): SocialAuthenticator {
  return {
    buildAuthorizationUrl(app: AppCredentials, params: AuthorizationUrlParams): string {
      const url = new URL(AUTHORIZE_URL);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', app.clientId);
      url.searchParams.set('redirect_uri', app.redirectUri);
      // O X separa escopos com espaço (RFC 6749)
      url.searchParams.set('scope', params.scopes.join(' '));
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
        code: params.code,
        grant_type: 'authorization_code',
        redirect_uri: app.redirectUri,
        code_verifier: params.codeVerifier ?? '',
      });

      const creds = await requisitarToken(app, body, ctx);
      const identity = await fetchUserIdentity(creds.accessToken, ctx);

      return {
        credentials: creds,
        identity,
      };
    },

    async refreshCredentials(
      app: AppCredentials,
      credentials: PlatformCredentials,
      ctx: AdapterContext,
    ): Promise<PlatformCredentials> {
      if (!credentials.refreshToken) {
        throw new TokenExpiredError(
          PLATFORM,
          'Conta do X sem refresh token disponível. É necessária a reconexão pelo usuário.',
        );
      }

      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: credentials.refreshToken,
        client_id: app.clientId,
      });

      return requisitarToken(app, body, ctx);
    },

    async fetchIdentity(
      credentials: PlatformCredentials,
      ctx: AdapterContext,
    ): Promise<RemoteAccountIdentity> {
      return fetchUserIdentity(credentials.accessToken, ctx);
    },

    async revoke(
      app: AppCredentials,
      credentials: PlatformCredentials,
      ctx: AdapterContext,
    ): Promise<void> {
      const { signal, cancel } = withTimeout(ctx.timeoutMs, ctx.signal);
      const credencialBase64 = Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64');

      try {
        const body = new URLSearchParams({
          token: credentials.accessToken,
          token_type_hint: 'access_token',
        });

        await fetch(REVOKE_URL, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${credencialBase64}`,
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          },
          body: body.toString(),
          signal,
        });
      } catch (erro) {
        ctx.logger.warn('Falha ao revogar token na API do X (continuando desativação local)', {
          error: erro instanceof Error ? erro.message : String(erro),
        });
      } finally {
        cancel();
      }
    },
  };
}

async function fetchUserIdentity(
  accessToken: string,
  ctx: AdapterContext,
): Promise<RemoteAccountIdentity> {
  const resp = await xRequest<UserMeResponse>({
    path: '/2/users/me',
    accessToken,
    method: 'GET',
    query: {
      'user.fields': 'profile_image_url,name,username',
    },
    ctx,
  });

  const user = resp.data;
  if (!user?.id || !user.username) {
    throw new PlatformApiError('A API do X não retornou as informações básicas da conta (id/username).', {
      platform: PLATFORM,
      retryable: false,
    });
  }

  return {
    remoteId: user.id,
    displayName: user.name || user.username,
    username: user.username,
    avatarUrl: user.profile_image_url,
    profileUrl: `https://x.com/${user.username}`,
  };
}

async function requisitarToken(
  app: AppCredentials,
  body: URLSearchParams,
  ctx: AdapterContext,
): Promise<PlatformCredentials> {
  const { signal, cancel } = withTimeout(ctx.timeoutMs, ctx.signal);
  const basicAuth = Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64');

  try {
    const resposta = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      body: body.toString(),
      signal,
    });

    const texto = await resposta.text();
    const data = (texto ? JSON.parse(texto) : {}) as OAuthTokenResponse;

    if (!resposta.ok || data.error) {
      const msg = data.error_description || data.error || `HTTP ${resposta.status}`;
      if (data.error === 'invalid_grant' || resposta.status === 401) {
        throw new TokenExpiredError(PLATFORM, `Falha na autorização do X: ${msg}`);
      }
      throw new PlatformApiError(`Falha ao obter tokens do X: ${msg}`, {
        platform: PLATFORM,
        httpStatus: resposta.status,
        retryable: false,
      });
    }

    if (!data.access_token) {
      throw new PlatformApiError('A API do X não devolveu o access_token.', {
        platform: PLATFORM,
        retryable: false,
      });
    }

    const agora = Date.now();
    const expiresInSeg = data.expires_in ?? 7200; // Padrão de 2 horas

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(agora + expiresInSeg * 1000),
      scopes: data.scope ? data.scope.split(' ').filter(Boolean) : [],
    };
  } finally {
    cancel();
  }
}
