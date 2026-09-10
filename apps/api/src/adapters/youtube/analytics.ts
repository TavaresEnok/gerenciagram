import type {
  AccountMetrics,
  AdapterContext,
  MetricsWindow,
  PlatformCredentials,
  PostMetrics,
  SocialAnalytics,
} from '@app/core';
import { googleRequest } from './http.js';

/**
 * Métricas pelo que a YouTube Data API realmente entrega.
 *
 * Limite honesto (declarado como PARTIAL no registro de plataformas): a Data
 * API dá contadores acumulados — inscritos, visualizações, likes, comentários.
 * Alcance, impressões, retenção e tempo de exibição vivem na YouTube
 * Analytics API, que é outro produto com outro escopo de OAuth. Enquanto esse
 * escopo não for solicitado, esses campos ficam ausentes em vez de estimados.
 */

const CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels';
const VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos';

interface ChannelStatsResponse {
  items?: Array<{
    statistics?: {
      viewCount?: string;
      subscriberCount?: string;
      hiddenSubscriberCount?: boolean;
      videoCount?: string;
    };
  }>;
}

interface VideoStatsResponse {
  items?: Array<{
    id: string;
    statistics?: {
      viewCount?: string;
      likeCount?: string;
      dislikeCount?: string;
      favoriteCount?: string;
      commentCount?: string;
    };
  }>;
}

export function createYouTubeAnalytics(): SocialAnalytics {
  return {
    async fetchAccountMetrics(
      credentials: PlatformCredentials,
      _window: MetricsWindow,
      ctx: AdapterContext,
    ): Promise<AccountMetrics> {
      const url = new URL(CHANNELS_URL);
      url.searchParams.set('part', 'statistics');
      url.searchParams.set('mine', 'true');

      const response = await googleRequest<ChannelStatsResponse>({
        url: url.toString(),
        accessToken: credentials.accessToken,
        ctx,
      });

      const stats = response.items?.[0]?.statistics;
      if (!stats) return {};

      const metrics: AccountMetrics = { raw: stats };

      // hiddenSubscriberCount: o canal escondeu o número. Omitir é correto;
      // devolver 0 seria inventar uma queda de inscritos no gráfico.
      if (!stats.hiddenSubscriberCount && stats.subscriberCount !== undefined) {
        metrics.followers = Number(stats.subscriberCount);
      }
      if (stats.viewCount !== undefined) {
        metrics.views = Number(stats.viewCount);
      }

      return metrics;
    },

    async fetchPostMetrics(
      credentials: PlatformCredentials,
      remoteIds: string[],
      ctx: AdapterContext,
    ): Promise<Map<string, PostMetrics>> {
      const result = new Map<string, PostMetrics>();
      if (remoteIds.length === 0) return result;

      // A API aceita até 50 ids por chamada; cada chamada custa 1 unidade,
      // então agrupar economiza cota do projeto (SPEC seção 12).
      for (let i = 0; i < remoteIds.length; i += 50) {
        const batch = remoteIds.slice(i, i + 50);

        const url = new URL(VIDEOS_URL);
        url.searchParams.set('part', 'statistics');
        url.searchParams.set('id', batch.join(','));

        const response = await googleRequest<VideoStatsResponse>({
          url: url.toString(),
          accessToken: credentials.accessToken,
          ctx,
        });

        for (const item of response.items ?? []) {
          const stats = item.statistics;
          if (!stats) continue;

          const metrics: PostMetrics = { raw: stats };
          if (stats.viewCount !== undefined) metrics.views = Number(stats.viewCount);
          if (stats.likeCount !== undefined) metrics.likes = Number(stats.likeCount);
          if (stats.commentCount !== undefined) metrics.comments = Number(stats.commentCount);

          result.set(item.id, metrics);
        }
      }

      return result;
    },
  };
}
