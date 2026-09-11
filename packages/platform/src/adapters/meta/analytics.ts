import type {
  AccountMetrics,
  AdapterContext,
  MetricsWindow,
  PlatformCredentials,
  PostMetrics,
  SocialAnalytics,
} from '@app/core';
import { graphRequest } from './http.js';

/**
 * Métricas do Instagram e do Facebook.
 *
 * A Meta devolve as insights num formato aninhado (`data[].values[].value`) e
 * o conjunto de métricas disponíveis varia por tipo de conta e de mídia.
 * Métrica que a API não devolver fica **ausente** — nunca vira zero, porque
 * num gráfico um zero é indistinguível de uma queda real.
 */

interface InsightsResponse {
  data?: Array<{
    name?: string;
    values?: Array<{ value?: number | Record<string, number> }>;
  }>;
}

/** Soma os valores de uma métrica no período, ignorando o que não é número. */
function somar(resposta: InsightsResponse, nome: string): number | undefined {
  const serie = resposta.data?.find((item) => item.name === nome);
  if (!serie?.values) return undefined;

  let total = 0;
  let achou = false;

  for (const ponto of serie.values) {
    if (typeof ponto.value === 'number') {
      total += ponto.value;
      achou = true;
    }
  }

  return achou ? total : undefined;
}

/** Último valor de uma métrica cumulativa (seguidores, por exemplo). */
function ultimo(resposta: InsightsResponse, nome: string): number | undefined {
  const serie = resposta.data?.find((item) => item.name === nome);
  const valores = serie?.values ?? [];

  for (let indice = valores.length - 1; indice >= 0; indice -= 1) {
    const valor = valores[indice]?.value;
    if (typeof valor === 'number') return valor;
  }

  return undefined;
}

/**
 * Só grava a métrica quando ela realmente veio da API.
 *
 * O tipo é genérico em vez de `Record<string, unknown>` porque
 * `AccountMetrics` e `PostMetrics` são interfaces fechadas — o que é
 * proposital: um erro de digitação no nome da métrica deve falhar na
 * compilação, não virar um campo silenciosamente ignorado.
 */
function atribuir<T extends object>(destino: T, chave: keyof T, valor: number | undefined): void {
  if (valor !== undefined) {
    (destino as Record<string, unknown>)[chave as string] = valor;
  }
}

// ---------------------------------------------------------------------------

export function createInstagramAnalytics(apiVersion: string): SocialAnalytics {
  return {
    async fetchAccountMetrics(
      credentials: PlatformCredentials,
      window: MetricsWindow,
      ctx: AdapterContext,
    ): Promise<AccountMetrics> {
      // `/me` resolve para a conta dona do token — o Page Access Token já
      // aponta para a conta certa, então não é preciso passar o id.
      const perfil = await graphRequest<{ followers_count?: number; id?: string }>({
        path: '/me',
        params: { fields: 'followers_count' },
        accessToken: credentials.accessToken,
        apiVersion,
        ctx,
      }).catch(() => ({ followers_count: undefined }));

      const insights = await graphRequest<InsightsResponse>({
        path: '/me/insights',
        params: {
          metric: 'impressions,reach',
          period: 'day',
          since: Math.floor(window.since.getTime() / 1000),
          until: Math.floor(window.until.getTime() / 1000),
        },
        accessToken: credentials.accessToken,
        apiVersion,
        ctx,
      }).catch(() => ({ data: [] }));

      const metricas: AccountMetrics = { raw: { perfil, insights } };

      atribuir(metricas, 'followers', perfil.followers_count);
      atribuir(metricas, 'impressions', somar(insights, 'impressions'));
      atribuir(metricas, 'reach', somar(insights, 'reach'));

      return metricas;
    },

    async fetchPostMetrics(
      credentials: PlatformCredentials,
      remoteIds: string[],
      ctx: AdapterContext,
    ): Promise<Map<string, PostMetrics>> {
      const resultado = new Map<string, PostMetrics>();

      // As insights de mídia são por objeto: não há endpoint em lote. Uma
      // chamada por post, com o limite de 200 que o worker já impõe.
      for (const remoteId of remoteIds) {
        const insights = await graphRequest<InsightsResponse>({
          path: `/${remoteId}/insights`,
          params: { metric: 'impressions,reach,likes,comments,saved,shares' },
          accessToken: credentials.accessToken,
          apiVersion,
          ctx,
        }).catch(() => null);

        if (!insights) continue;

        const metricas: PostMetrics = { raw: insights as unknown as Record<string, unknown> };

        atribuir(metricas, 'impressions', somar(insights, 'impressions'));
        atribuir(metricas, 'reach', somar(insights, 'reach'));
        atribuir(metricas, 'likes', somar(insights, 'likes'));
        atribuir(metricas, 'comments', somar(insights, 'comments'));
        atribuir(metricas, 'saves', somar(insights, 'saved'));
        atribuir(metricas, 'shares', somar(insights, 'shares'));

        resultado.set(remoteId, metricas);
      }

      return resultado;
    },
  };
}

// ---------------------------------------------------------------------------

export function createFacebookAnalytics(apiVersion: string): SocialAnalytics {
  return {
    async fetchAccountMetrics(
      credentials: PlatformCredentials,
      window: MetricsWindow,
      ctx: AdapterContext,
    ): Promise<AccountMetrics> {
      const insights = await graphRequest<InsightsResponse>({
        path: '/me/insights',
        params: {
          metric: 'page_impressions,page_impressions_unique,page_fans',
          period: 'day',
          since: Math.floor(window.since.getTime() / 1000),
          until: Math.floor(window.until.getTime() / 1000),
        },
        accessToken: credentials.accessToken,
        apiVersion,
        ctx,
      }).catch(() => ({ data: [] }));

      const metricas: AccountMetrics = { raw: insights as unknown as Record<string, unknown> };

      // page_fans é cumulativo: somar daria um número sem significado.
      atribuir(metricas, 'followers', ultimo(insights, 'page_fans'));
      atribuir(metricas, 'impressions', somar(insights, 'page_impressions'));
      atribuir(metricas, 'reach', somar(insights, 'page_impressions_unique'));

      return metricas;
    },

    async fetchPostMetrics(
      credentials: PlatformCredentials,
      remoteIds: string[],
      ctx: AdapterContext,
    ): Promise<Map<string, PostMetrics>> {
      const resultado = new Map<string, PostMetrics>();

      for (const remoteId of remoteIds) {
        const insights = await graphRequest<InsightsResponse>({
          path: `/${remoteId}/insights`,
          params: { metric: 'post_impressions,post_impressions_unique,post_clicks' },
          accessToken: credentials.accessToken,
          apiVersion,
          ctx,
        }).catch(() => null);

        // Curtidas e comentários não são insights: vêm como contadores de
        // resumo no próprio post.
        const resumo = await graphRequest<{
          likes?: { summary?: { total_count?: number } };
          comments?: { summary?: { total_count?: number } };
          shares?: { count?: number };
        }>({
          path: `/${remoteId}`,
          params: {
            fields: 'likes.summary(true),comments.summary(true),shares',
          },
          accessToken: credentials.accessToken,
          apiVersion,
          ctx,
        }).catch(() => null);

        if (!insights && !resumo) continue;

        const metricas: PostMetrics = { raw: { insights, resumo } };

        if (insights) {
          atribuir(metricas, 'impressions', somar(insights, 'post_impressions'));
          atribuir(metricas, 'reach', somar(insights, 'post_impressions_unique'));
          atribuir(metricas, 'clicks', somar(insights, 'post_clicks'));
        }
        if (resumo) {
          atribuir(metricas, 'likes', resumo.likes?.summary?.total_count);
          atribuir(metricas, 'comments', resumo.comments?.summary?.total_count);
          atribuir(metricas, 'shares', resumo.shares?.count);
        }

        resultado.set(remoteId, metricas);
      }

      return resultado;
    },
  };
}
