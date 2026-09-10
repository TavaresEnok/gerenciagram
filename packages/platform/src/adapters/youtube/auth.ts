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
import { googleRequest } from './http.js';

/**
 * OAuth 2.0 do Google para o YouTube.
 *
 * Detalhes que a documentação oficial exige e que mudam o comportamento:
 *
 *  - `access_type=offline` + `prompt=consent` são o que faz o Google devolver
 *    um refresh token. Sem `prompt=consent`, uma segunda autorização do mesmo
 *    usuário volta SEM refresh token, e a conta para de funcionar em 1 hora.
 *  - o refresh token do Google não expira por tempo, mas é revogado se o
 *    usuário tirar o acesso ou se o app estiver em modo de teste (7 dias).
 *  - `include_granted_scopes` preserva escopos já concedidos em conexões
 *    anteriores, evitando pedir tudo de novo (menor privilégio, seção 10).
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels';

const PLATFORM = 'YouTube';

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type: string;
}

interface ChannelListResponse {
  items?: Array<{
    id: string;
    snippet?: {
      title?: string;
      customUrl?: string;
      thumbnails?: { default?: { url?: string }; medium?: { url?: string } };
    };
    status?: { isLinked?: boolean };
    contentDetails?: unknown;
  }>;
}

export function createYouTubeAuthenticator(): SocialAuthenticator {
  return {
    buildAuthorizationUrl(app: AppCredentials, params: AuthorizationUrlParams): string {
      const url = new URL(AUTH_URL);
      url.searchParams.set('client_id', app.clientId);
      url.searchParams.set('redirect_uri', app.redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', params.scopes.join(' '));
      url.searchParams.set('state', params.state);
      url.searchParams.set('access_type', 'offline');
      url.searchParams.set('prompt', 'consent');
      url.searchParams.set('include_granted_scopes', 'true');

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
        client_id: app.clientId,
        client_secret: app.clientSecret,
        redirect_uri: app.redirectUri,
        grant_type: 'authorization_code',
      });
      if (params.codeVerifier) body.set('code_verifier', params.codeVerifier);

      const token = await postForm<TokenResponse>(TOKEN_URL, body, ctx);

      if (!token.refresh_token) {
        // Falhar aqui é melhor do que conectar uma conta que morre em 1 hora
        // sem ninguém entender por quê.
        throw new PlatformApiError(
          'O Google não devolveu um refresh token. Remova o acesso do aplicativo em ' +
            'myaccount.google.com/permissions e conecte a conta novamente.',
          { retryable: false, platform: PLATFORM },
        );
      }

      const credentials: PlatformCredentials = {
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: new Date(Date.now() + token.expires_in * 1000),
        scopes: token.scope?.split(' ') ?? [],
      };

      const identity = await fetchChannelIdentity(credentials, ctx);
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
          'Esta conta não tem refresh token guardado. É preciso reconectar.',
        );
      }

      const body = new URLSearchParams({
        refresh_token: credentials.refreshToken,
        client_id: app.clientId,
        client_secret: app.clientSecret,
        grant_type: 'refresh_token',
      });

      let token: TokenResponse;
      try {
        token = await postForm<TokenResponse>(TOKEN_URL, body, ctx);
      } catch (error) {
        // invalid_grant = refresh token revogado. Não adianta re-tentar: o
        // usuário precisa reconectar a conta.
        if (error instanceof PlatformApiError && /invalid_grant/i.test(error.message)) {
          throw new TokenExpiredError(
            PLATFORM,
            'O acesso a esta conta foi revogado no Google. Reconecte a conta.',
          );
        }
        throw error;
      }

      return {
        accessToken: token.access_token,
        // O Google normalmente NÃO devolve um refresh token novo no refresh;
        // manter o antigo é obrigatório para a conta continuar funcionando.
        refreshToken: token.refresh_token ?? credentials.refreshToken,
        expiresAt: new Date(Date.now() + token.expires_in * 1000),
        scopes: token.scope?.split(' ') ?? credentials.scopes,
      };
    },

    async revoke(
      _app: AppCredentials,
      credentials: PlatformCredentials,
      ctx: AdapterContext,
    ): Promise<void> {
      // Exigido pelo direito de exclusão da LGPD (SPEC seção 11): apagar a
      // linha do banco não desfaz a autorização junto ao Google.
      const body = new URLSearchParams({
        token: credentials.refreshToken ?? credentials.accessToken,
      });

      try {
        await postForm<unknown>(REVOKE_URL, body, ctx);
      } catch (error) {
        // Token já inválido devolve 400. Do ponto de vista da revogação, o
        // objetivo foi atingido — não é falha.
        if (error instanceof PlatformApiError && error.details) {
          const status = (error.details as { httpStatus?: number }).httpStatus;
          if (status === 400) return;
        }
        throw error;
      }
    },

    async fetchIdentity(
      credentials: PlatformCredentials,
      ctx: AdapterContext,
    ): Promise<RemoteAccountIdentity> {
      return fetchChannelIdentity(credentials, ctx);
    },
  };
}

async function fetchChannelIdentity(
  credentials: PlatformCredentials,
  ctx: AdapterContext,
): Promise<RemoteAccountIdentity> {
  const url = new URL(CHANNELS_URL);
  url.searchParams.set('part', 'snippet,contentDetails,status');
  url.searchParams.set('mine', 'true');

  const response = await googleRequest<ChannelListResponse>({
    url: url.toString(),
    accessToken: credentials.accessToken,
    ctx,
  });

  const channel = response.items?.[0];
  if (!channel) {
    throw new PlatformApiError(
      'Esta conta do Google não tem um canal do YouTube. Crie um canal antes de conectar.',
      { retryable: false, platform: PLATFORM },
    );
  }

  const identity: RemoteAccountIdentity = {
    remoteId: channel.id,
    metadata: { uploadsPlaylistId: extractUploadsPlaylist(channel.contentDetails) },
  };

  if (channel.snippet?.title) identity.displayName = channel.snippet.title;
  if (channel.snippet?.customUrl) identity.username = channel.snippet.customUrl;

  const avatar =
    channel.snippet?.thumbnails?.medium?.url ?? channel.snippet?.thumbnails?.default?.url;
  if (avatar) identity.avatarUrl = avatar;

  identity.profileUrl = channel.snippet?.customUrl
    ? `https://www.youtube.com/${channel.snippet.customUrl}`
    : `https://www.youtube.com/channel/${channel.id}`;

  return identity;
}

function extractUploadsPlaylist(contentDetails: unknown): string | undefined {
  const related = (contentDetails as { relatedPlaylists?: { uploads?: string } } | undefined)
    ?.relatedPlaylists;
  return related?.uploads;
}

/**
 * Os endpoints de token do Google usam form-urlencoded e NÃO aceitam o header
 * Authorization — as credenciais vão no corpo.
 */
async function postForm<T>(
  url: string,
  body: URLSearchParams,
  ctx: AdapterContext,
): Promise<T> {
  const { signal, cancel } = withTimeout(ctx.timeoutMs, ctx.signal);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
      signal,
    });

    const text = await response.text();

    if (!response.ok) {
      throw new PlatformApiError(`YouTube OAuth (${response.status}): ${text.slice(0, 300)}`, {
        retryable: response.status >= 500,
        platform: PLATFORM,
        httpStatus: response.status,
      });
    }

    return (text ? JSON.parse(text) : {}) as T;
  } catch (error) {
    if (error instanceof PlatformApiError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new PlatformApiError(`Tempo esgotado no OAuth do YouTube (${ctx.timeoutMs}ms)`, {
        retryable: true,
        platform: PLATFORM,
      });
    }
    throw new PlatformApiError(
      `Falha ao falar com o OAuth do Google: ${error instanceof Error ? error.message : String(error)}`,
      { retryable: true, platform: PLATFORM, cause: error },
    );
  } finally {
    cancel();
  }
}
