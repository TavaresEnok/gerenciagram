import {
  PlatformApiError,
  ValidationError,
  type AdapterContext,
  type DynamicFieldOptions,
  type PlatformCredentials,
  type PublishInput,
  type PublishResult,
  type RemotePostState,
  type SocialPublisher,
} from '@app/core';
import { graphRequest } from './http.js';

/**
 * Publicação numa Página do Facebook.
 *
 * Diferente do Instagram, aqui não há contêiner: cada tipo de conteúdo tem o
 * próprio endpoint, e a publicação é imediata.
 *
 *   texto/link → POST /{page-id}/feed
 *   foto       → POST /{page-id}/photos
 *   vídeo      → POST /{page-id}/videos
 *
 * É a única das seis redes com agendamento NATIVO documentado — mas com uma
 * janela estreita (10 minutos a 30 dias), então o agendamento longo continua
 * sendo da nossa fila.
 *
 * Referência: https://developers.facebook.com/docs/pages-api/posts
 */

/** Limites do `scheduled_publish_time`, em milissegundos. */
const AGENDAMENTO_MINIMO_MS = 10 * 60_000;
const AGENDAMENTO_MAXIMO_MS = 30 * 24 * 60 * 60_000;

interface PostResponse {
  id?: string;
  post_id?: string;
}

export function createFacebookPublisher(apiVersion: string): SocialPublisher {
  return {
    async publish(
      credentials: PlatformCredentials,
      input: PublishInput,
      ctx: AdapterContext,
    ): Promise<PublishResult> {
      const paginaId = extrairPaginaId(input);
      const mensagem = montarMensagem(input);
      const agendamento = montarAgendamento(input);

      const temVideo = input.media.some((midia) => midia.mimeType.startsWith('video/'));
      const temImagem = input.media.some((midia) => midia.mimeType.startsWith('image/'));

      let resposta: PostResponse;
      let caminho: string;

      if (temVideo) {
        const video = input.media.find((midia) => midia.mimeType.startsWith('video/'))!;
        exigirUrlPublica(video.publicUrl, video.filename);

        caminho = `/${paginaId}/videos`;
        resposta = await graphRequest<PostResponse>({
          method: 'POST',
          path: caminho,
          params: {
            file_url: video.publicUrl,
            description: mensagem,
            ...(input.title ? { title: input.title.slice(0, 255) } : {}),
            ...agendamento,
          },
          accessToken: credentials.accessToken,
          apiVersion,
          ctx,
        });
      } else if (temImagem) {
        const imagens = input.media.filter((midia) => midia.mimeType.startsWith('image/'));

        if (imagens.length === 1) {
          const imagem = imagens[0]!;
          exigirUrlPublica(imagem.publicUrl, imagem.filename);

          caminho = `/${paginaId}/photos`;
          resposta = await graphRequest<PostResponse>({
            method: 'POST',
            path: caminho,
            params: {
              url: imagem.publicUrl,
              caption: mensagem,
              ...agendamento,
            },
            accessToken: credentials.accessToken,
            apiVersion,
            ctx,
          });
        } else {
          // Várias fotos: a API não tem carrossel orgânico. O caminho
          // documentado é enviar cada foto SEM publicar e anexá-las a um post
          // de feed — o resultado é um álbum, não um carrossel.
          const ids: string[] = [];

          for (const imagem of imagens) {
            exigirUrlPublica(imagem.publicUrl, imagem.filename);

            const enviada = await graphRequest<{ id: string }>({
              method: 'POST',
              path: `/${paginaId}/photos`,
              params: { url: imagem.publicUrl, published: false },
              accessToken: credentials.accessToken,
              apiVersion,
              ctx,
            });

            ids.push(enviada.id);
          }

          const anexos: Record<string, string> = {};
          ids.forEach((id, indice) => {
            anexos[`attached_media[${indice}]`] = JSON.stringify({ media_fbid: id });
          });

          caminho = `/${paginaId}/feed`;
          resposta = await graphRequest<PostResponse>({
            method: 'POST',
            path: caminho,
            params: { message: mensagem, ...anexos, ...agendamento },
            accessToken: credentials.accessToken,
            apiVersion,
            ctx,
          });
        }
      } else {
        // Só texto — caso válido numa Página, ao contrário do Instagram.
        caminho = `/${paginaId}/feed`;
        resposta = await graphRequest<PostResponse>({
          method: 'POST',
          path: caminho,
          params: { message: mensagem, ...agendamento },
          accessToken: credentials.accessToken,
          apiVersion,
          ctx,
        });
      }

      const id = resposta.post_id ?? resposta.id;

      if (!id) {
        throw new PlatformApiError(
          'O Facebook aceitou a publicação mas não devolveu o id do post.',
          { retryable: true, platform: 'Facebook' },
        );
      }

      return {
        remoteId: id,
        remoteUrl: `https://www.facebook.com/${id.replace('_', '/posts/')}`,
        // Vídeo passa por transcodificação; os demais tipos vão ao ar direto.
        processingPending: temVideo,
      };
    },

    async fetchRemoteState(
      credentials: PlatformCredentials,
      remoteId: string,
      ctx: AdapterContext,
    ): Promise<RemotePostState> {
      const post = await graphRequest<{
        id?: string;
        is_published?: boolean;
        permalink_url?: string;
        status?: string;
      }>({
        path: `/${remoteId}`,
        params: { fields: 'id,is_published,permalink_url' },
        accessToken: credentials.accessToken,
        apiVersion,
        ctx,
      }).catch(() => null);

      if (!post?.id) return { remoteId, status: 'DELETED' };

      return {
        remoteId,
        // `is_published: false` num post agendado é esperado — ele ainda não
        // saiu, mas existe. Não é rejeição.
        status: post.is_published === false ? 'PROCESSING' : 'READY',
        ...(post.permalink_url ? { remoteUrl: post.permalink_url } : {}),
      };
    },

    async deletePost(
      credentials: PlatformCredentials,
      remoteId: string,
      ctx: AdapterContext,
    ): Promise<void> {
      await graphRequest<{ success?: boolean }>({
        method: 'DELETE',
        path: `/${remoteId}`,
        accessToken: credentials.accessToken,
        apiVersion,
        ctx,
      });
    },

    async fetchDynamicFieldOptions(): Promise<DynamicFieldOptions[]> {
      return [];
    },
  };
}

// ---------------------------------------------------------------------------

/**
 * Agendamento nativo, quando o horário cai na janela que o Facebook aceita.
 *
 * Fora dela a API recusa, então preferimos publicar na hora (a nossa fila já
 * segurou o job até o momento certo) a mandar um parâmetro que seria rejeitado.
 */
function montarAgendamento(input: PublishInput): Record<string, string | number | boolean> {
  if (!input.publishAt) return {};

  const distancia = input.publishAt.getTime() - Date.now();

  if (distancia < AGENDAMENTO_MINIMO_MS || distancia > AGENDAMENTO_MAXIMO_MS) {
    return {};
  }

  return {
    published: false,
    scheduled_publish_time: Math.floor(input.publishAt.getTime() / 1000),
  };
}

function exigirUrlPublica(url: string | undefined, nomeArquivo: string): asserts url is string {
  if (!url) {
    throw new PlatformApiError(
      `O Facebook precisa buscar "${nomeArquivo}" numa URL acessível publicamente, e ` +
        `nenhuma foi fornecida. Verifique a configuração do storage.`,
      { retryable: false, platform: 'Facebook' },
    );
  }
}

function extrairPaginaId(input: PublishInput): string {
  const valor = input.platformFields['__remoteAccountId'];

  if (typeof valor !== 'string' || valor.length === 0) {
    throw new PlatformApiError(
      'O identificador da Página do Facebook não foi informado na publicação.',
      { retryable: false, platform: 'Facebook' },
    );
  }

  return valor;
}

function montarMensagem(input: PublishInput): string {
  const hashtags = input.hashtags.map((tag) => `#${tag.replace(/^#/, '')}`).join(' ');

  return [input.title, input.body, hashtags]
    .filter((parte): parte is string => Boolean(parte && parte.trim().length > 0))
    .join('\n\n')
    .slice(0, 63_206);
}

export { ValidationError };
