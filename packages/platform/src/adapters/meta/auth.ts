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
import { graphRequest } from './http.js';

/**
 * OAuth da Meta, para Instagram e Facebook.
 *
 * O modelo de token da Meta é diferente do Google, e a diferença importa:
 *
 *  - não existe refresh token. O que existe é um token de LONGA DURAÇÃO
 *    (60 dias) que se **troca por outro** antes de expirar;
 *  - um token não renovado em 60 dias morre e não pode mais ser renovado —
 *    aí só reconectando. Por isso o worker renova preventivamente;
 *  - publicar numa Página usa o **Page Access Token**, não o do usuário. Ele
 *    é obtido a partir do token do usuário e é o que guardamos.
 */

const OAUTH_HOST = 'https://www.facebook.com';
const GRAPH_HOST = 'https://graph.facebook.com';

/** Trocamos o token bem antes dos 60 dias, para nunca chegar perto do limite. */
const DIAS_DE_VIDA = 60;

interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
}

interface ContaInstagram {
  id: string;
  username?: string;
  name?: string;
  profile_picture_url?: string;
}

interface PaginaResponse {
  data?: Array<{
    id: string;
    name?: string;
    access_token?: string;
    category?: string;
    picture?: { data?: { url?: string } };
    instagram_business_account?: ContaInstagram;
  }>;
}

export type AlvoMeta = 'INSTAGRAM' | 'FACEBOOK';

export function createMetaAuthenticator(
  alvo: AlvoMeta,
  apiVersion: string,
): SocialAuthenticator {
  return {
    buildAuthorizationUrl(app: AppCredentials, params: AuthorizationUrlParams): string {
      const url = new URL(`${OAUTH_HOST}/${apiVersion}/dialog/oauth`);
      url.searchParams.set('client_id', app.clientId);
      url.searchParams.set('redirect_uri', app.redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', params.scopes.join(','));
      url.searchParams.set('state', params.state);
      return url.toString();
    },

    async exchangeCodeForTokens(
      app: AppCredentials,
      params: OAuthCallbackParams,
      ctx: AdapterContext,
    ): Promise<TokenExchangeResult> {
      // 1. Código → token de curta duração
      const curto = await chamarOAuth<TokenResponse>(
        `${GRAPH_HOST}/${apiVersion}/oauth/access_token`,
        {
          client_id: app.clientId,
          client_secret: app.clientSecret,
          redirect_uri: app.redirectUri,
          code: params.code,
        },
        ctx,
      );

      // 2. Curta → longa duração (60 dias)
      const longo = await chamarOAuth<TokenResponse>(
        `${GRAPH_HOST}/${apiVersion}/oauth/access_token`,
        {
          grant_type: 'fb_exchange_token',
          client_id: app.clientId,
          client_secret: app.clientSecret,
          fb_exchange_token: curto.access_token,
        },
        ctx,
      );

      const escopos = await lerEscopos(longo.access_token, apiVersion, ctx);

      // 3. Descobrir a Página (e, no caso do Instagram, a conta vinculada).
      //    O token que guardamos é o DA PÁGINA — o do usuário não publica.
      const { identity, pageToken } = await resolverAlvo(
        alvo,
        longo.access_token,
        apiVersion,
        ctx,
      );

      return {
        credentials: {
          accessToken: pageToken,
          // Sem refresh token: a renovação troca o próprio token de longa
          // duração. Guardamos o do usuário para conseguir refazer a troca.
          refreshToken: longo.access_token,
          expiresAt: new Date(Date.now() + DIAS_DE_VIDA * 24 * 60 * 60_000),
          scopes: escopos,
        },
        identity,
      };
    },

    /**
     * "Renovar" na Meta é trocar o token de longa duração por outro.
     * Precisa acontecer ANTES dos 60 dias: depois disso, nem a troca funciona.
     */
    async refreshCredentials(
      app: AppCredentials,
      credentials: PlatformCredentials,
      ctx: AdapterContext,
    ): Promise<PlatformCredentials> {
      const tokenUsuario = credentials.refreshToken;

      if (!tokenUsuario) {
        throw new TokenExpiredError(
          'Meta',
          'Esta conta não tem o token de usuário guardado para renovação. É preciso reconectar.',
        );
      }

      let renovado: TokenResponse;
      try {
        renovado = await chamarOAuth<TokenResponse>(
          `${GRAPH_HOST}/${apiVersion}/oauth/access_token`,
          {
            grant_type: 'fb_exchange_token',
            client_id: app.clientId,
            client_secret: app.clientSecret,
            fb_exchange_token: tokenUsuario,
          },
          ctx,
        );
      } catch (erro) {
        if (erro instanceof PlatformApiError && /OAuthException|expired|invalid/i.test(erro.message)) {
          throw new TokenExpiredError(
            'Meta',
            'O acesso a esta conta expirou na Meta. Reconecte a conta.',
          );
        }
        throw erro;
      }

      // O Page Access Token deriva do token de usuário: renovar um exige
      // rebuscar o outro, senão o token de página continua o antigo.
      const { pageToken } = await resolverAlvo(alvo, renovado.access_token, apiVersion, ctx);

      return {
        accessToken: pageToken,
        refreshToken: renovado.access_token,
        expiresAt: new Date(Date.now() + DIAS_DE_VIDA * 24 * 60 * 60_000),
        scopes: credentials.scopes,
      };
    },

    /**
     * A Meta revoga pela própria Graph API: `DELETE /{user-id}/permissions`
     * remove todas as permissões concedidas ao app.
     */
    async revoke(
      _app: AppCredentials,
      credentials: PlatformCredentials,
      ctx: AdapterContext,
    ): Promise<void> {
      const tokenUsuario = credentials.refreshToken ?? credentials.accessToken;

      await graphRequest<{ success?: boolean }>({
        method: 'DELETE',
        path: '/me/permissions',
        accessToken: tokenUsuario,
        apiVersion,
        ctx,
      }).catch((erro: unknown) => {
        // Token já inválido: do ponto de vista da revogação, o objetivo foi
        // atingido. Não faz sentido falhar a desconexão por isso.
        if (erro instanceof TokenExpiredError) return;
        throw erro;
      });
    },

    async fetchIdentity(
      credentials: PlatformCredentials,
      ctx: AdapterContext,
    ): Promise<RemoteAccountIdentity> {
      const tokenUsuario = credentials.refreshToken ?? credentials.accessToken;
      const { identity } = await resolverAlvo(alvo, tokenUsuario, apiVersion, ctx);
      return identity;
    },
  };
}

// ---------------------------------------------------------------------------

/**
 * Resolve qual conta será conectada e devolve o token que publica nela.
 *
 * No Facebook o alvo é a Página. No Instagram é a conta profissional
 * **vinculada** a uma Página — e o token continua sendo o da Página.
 */
async function resolverAlvo(
  alvo: AlvoMeta,
  tokenUsuario: string,
  apiVersion: string,
  ctx: AdapterContext,
): Promise<{ identity: RemoteAccountIdentity; pageToken: string }> {
  const paginas = await graphRequest<PaginaResponse>({
    path: '/me/accounts',
    params: {
      fields:
        'id,name,access_token,category,picture{url},instagram_business_account{id,username,name,profile_picture_url}',
      limit: 100,
    },
    accessToken: tokenUsuario,
    apiVersion,
    ctx,
  });

  const lista = paginas.data ?? [];

  if (lista.length === 0) {
    throw new PlatformApiError(
      'Nenhuma Página do Facebook foi encontrada para esta conta. A publicação pela API ' +
        'exige uma Página — perfil pessoal não publica.',
      { retryable: false, platform: 'Meta' },
    );
  }

  if (alvo === 'FACEBOOK') {
    // Quando há várias Páginas, conectamos a primeira e registramos as demais
    // no metadata: a escolha entre elas é da interface, não do adapter.
    const pagina = lista[0]!;

    if (!pagina.access_token) {
      throw new PlatformApiError(
        `A Meta não devolveu o token da Página "${pagina.name ?? pagina.id}". ` +
          `Confirme que você tem papel de administrador nela.`,
        { retryable: false, platform: 'Meta' },
      );
    }

    const identity: RemoteAccountIdentity = {
      remoteId: pagina.id,
      isBusinessAccount: true,
      profileUrl: `https://www.facebook.com/${pagina.id}`,
      metadata: {
        pageCategory: pagina.category ?? null,
        outrasPaginas: lista.slice(1).map((item) => ({ id: item.id, name: item.name })),
      },
    };

    if (pagina.name) identity.displayName = pagina.name;
    const avatar = pagina.picture?.data?.url;
    if (avatar) identity.avatarUrl = avatar;

    return { identity, pageToken: pagina.access_token };
  }

  // Instagram: precisa de uma Página COM conta profissional vinculada.
  const comInstagram = lista.find((item) => item.instagram_business_account?.id);

  if (!comInstagram?.instagram_business_account) {
    throw new PlatformApiError(
      'Nenhuma conta profissional do Instagram vinculada a uma Página foi encontrada. ' +
        'A publicação pela API exige conta Business ou Creator vinculada a uma Página do ' +
        'Facebook.',
      { retryable: false, platform: 'Meta' },
    );
  }

  if (!comInstagram.access_token) {
    throw new PlatformApiError(
      'A Meta não devolveu o token da Página vinculada a esta conta do Instagram.',
      { retryable: false, platform: 'Meta' },
    );
  }

  const conta = comInstagram.instagram_business_account;

  const identity: RemoteAccountIdentity = {
    remoteId: conta.id,
    isBusinessAccount: true,
    metadata: { pageId: comInstagram.id, pageName: comInstagram.name ?? null },
  };

  if (conta.username) {
    identity.username = conta.username;
    identity.profileUrl = `https://www.instagram.com/${conta.username}`;
  }
  if (conta.name) identity.displayName = conta.name;
  if (conta.profile_picture_url) identity.avatarUrl = conta.profile_picture_url;

  return { identity, pageToken: comInstagram.access_token };
}

/** Escopos efetivamente concedidos — o usuário pode ter recusado algum. */
async function lerEscopos(
  accessToken: string,
  apiVersion: string,
  ctx: AdapterContext,
): Promise<string[]> {
  const resposta = await graphRequest<{
    data?: Array<{ permission: string; status: string }>;
  }>({
    path: '/me/permissions',
    accessToken,
    apiVersion,
    ctx,
  }).catch(() => ({ data: [] as Array<{ permission: string; status: string }> }));

  return (resposta.data ?? [])
    .filter((item) => item.status === 'granted')
    .map((item) => item.permission);
}

/**
 * Os endpoints de OAuth da Meta não aceitam o token no header Authorization —
 * as credenciais vão na querystring.
 */
async function chamarOAuth<T>(
  url: string,
  params: Record<string, string>,
  ctx: AdapterContext,
): Promise<T> {
  const { signal, cancel } = withTimeout(ctx.timeoutMs, ctx.signal);
  const destino = new URL(url);

  for (const [chave, valor] of Object.entries(params)) {
    destino.searchParams.set(chave, valor);
  }

  try {
    const resposta = await fetch(destino.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal,
    });

    const texto = await resposta.text();

    if (!resposta.ok) {
      throw new PlatformApiError(`OAuth da Meta (${resposta.status}): ${texto.slice(0, 300)}`, {
        retryable: resposta.status >= 500,
        platform: 'Meta',
        httpStatus: resposta.status,
      });
    }

    return JSON.parse(texto) as T;
  } catch (erro) {
    if (erro instanceof PlatformApiError) throw erro;
    if (erro instanceof Error && erro.name === 'AbortError') {
      throw new PlatformApiError(`Tempo esgotado no OAuth da Meta (${ctx.timeoutMs}ms)`, {
        retryable: true,
        platform: 'Meta',
      });
    }
    throw new PlatformApiError(
      `Falha ao falar com o OAuth da Meta: ${erro instanceof Error ? erro.message : String(erro)}`,
      { retryable: true, platform: 'Meta', cause: erro },
    );
  } finally {
    cancel();
  }
}
