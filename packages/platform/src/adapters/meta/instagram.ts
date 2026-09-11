import {
  PlatformApiError,
  UnsupportedByPlatformError,
  type AdapterContext,
  type DynamicFieldOptions,
  type PlatformCredentials,
  type PublishInput,
  type PublishMediaInput,
  type PublishResult,
  type RemotePostState,
  type SocialPublisher,
} from '@app/core';
import { aguardarContainer, graphRequest } from './http.js';

/**
 * Publicação no Instagram.
 *
 * O fluxo da Meta tem três passos, e nenhum pode ser pulado:
 *
 *   1. criar um CONTÊINER por arquivo (a Meta busca a mídia numa URL pública)
 *   2. esperar o contêiner ficar `FINISHED` — a transcodificação é assíncrona
 *   3. publicar o contêiner
 *
 * Publicar antes do passo 2 falha. Carrossel acrescenta um contêiner-pai que
 * agrupa os filhos.
 *
 * Referência: https://developers.facebook.com/docs/instagram-platform/content-publishing
 */

interface ContainerResponse {
  id: string;
}

interface PublishResponse {
  id: string;
}

export function createInstagramPublisher(apiVersion: string): SocialPublisher {
  return {
    async publish(
      credentials: PlatformCredentials,
      input: PublishInput,
      ctx: AdapterContext,
    ): Promise<PublishResult> {
      const contaId = extrairContaId(input);

      if (input.media.length === 0) {
        throw new PlatformApiError('O Instagram exige pelo menos um arquivo de mídia.', {
          retryable: false,
          platform: 'Instagram',
        });
      }
      if (input.media.length > 10) {
        throw new UnsupportedByPlatformError('Instagram', 'carrossel com mais de 10 itens');
      }

      const legenda = montarLegenda(input);
      const ehCarrossel = input.media.length > 1;

      // --- Passo 1: um contêiner por arquivo -----------------------------
      const filhos: string[] = [];

      for (const midia of input.media) {
        const container = await criarContainer(
          contaId,
          midia,
          {
            apiVersion,
            accessToken: credentials.accessToken,
            ctx,
            // Num carrossel a legenda vai no pai, não nos filhos.
            ...(ehCarrossel ? { carrosselItem: true } : { legenda }),
          },
        );

        filhos.push(container);
      }

      // --- Passo 2: esperar a Meta processar -----------------------------
      for (const container of filhos) {
        await aguardarContainer(container, credentials.accessToken, apiVersion, ctx);
      }

      // --- Passo 3 (carrossel): contêiner-pai ----------------------------
      let containerFinal = filhos[0]!;

      if (ehCarrossel) {
        const pai = await graphRequest<ContainerResponse>({
          method: 'POST',
          path: `/${contaId}/media`,
          params: {
            media_type: 'CAROUSEL',
            children: filhos.join(','),
            caption: legenda,
          },
          accessToken: credentials.accessToken,
          apiVersion,
          ctx,
        });

        await aguardarContainer(pai.id, credentials.accessToken, apiVersion, ctx);
        containerFinal = pai.id;
      }

      // --- Passo 4: publicar ---------------------------------------------
      ctx.logger.debug('publicando contêiner no Instagram', {
        correlationId: ctx.correlationId,
        containerId: containerFinal,
      });

      const publicado = await graphRequest<PublishResponse>({
        method: 'POST',
        path: `/${contaId}/media_publish`,
        params: { creation_id: containerFinal },
        accessToken: credentials.accessToken,
        apiVersion,
        ctx,
      });

      if (!publicado.id) {
        throw new PlatformApiError(
          'O Instagram aceitou a publicação mas não devolveu o id da mídia.',
          { retryable: true, platform: 'Instagram' },
        );
      }

      // Buscamos a permalink separadamente: ela não vem na resposta de
      // publicação, e é o link que o usuário quer ver na fila.
      const permalink = await graphRequest<{ permalink?: string }>({
        path: `/${publicado.id}`,
        params: { fields: 'permalink' },
        accessToken: credentials.accessToken,
        apiVersion,
        ctx,
      }).catch(() => ({ permalink: undefined }));

      return {
        remoteId: publicado.id,
        ...(permalink.permalink ? { remoteUrl: permalink.permalink } : {}),
        // O Instagram publica de forma síncrona: quando o media_publish
        // retorna, a mídia já está no ar.
        processingPending: false,
      };
    },

    async fetchRemoteState(
      credentials: PlatformCredentials,
      remoteId: string,
      ctx: AdapterContext,
    ): Promise<RemotePostState> {
      const midia = await graphRequest<{ id?: string; permalink?: string }>({
        path: `/${remoteId}`,
        params: { fields: 'id,permalink' },
        accessToken: credentials.accessToken,
        apiVersion,
        ctx,
      }).catch(() => null);

      if (!midia?.id) return { remoteId, status: 'DELETED' };

      return {
        remoteId,
        status: 'READY',
        ...(midia.permalink ? { remoteUrl: midia.permalink } : {}),
      };
    },

    async deletePost(): Promise<void> {
      // A API de publicação da Meta não expõe exclusão de mídia publicada.
      // Fingir sucesso aqui deixaria o post no ar com a interface dizendo que
      // foi removido.
      throw new UnsupportedByPlatformError('Instagram', 'excluir publicação');
    },

    async fetchDynamicFieldOptions(): Promise<DynamicFieldOptions[]> {
      // O Instagram não tem campo obrigatório com opções vindas da API.
      return [];
    },
  };
}

// ---------------------------------------------------------------------------

async function criarContainer(
  contaId: string,
  midia: PublishMediaInput,
  opcoes: {
    apiVersion: string;
    accessToken: string;
    ctx: AdapterContext;
    legenda?: string;
    carrosselItem?: boolean;
  },
): Promise<string> {
  if (!midia.publicUrl) {
    // A Meta BUSCA a mídia; não há upload direto. Sem URL assinada não há o
    // que fazer, e inventar uma seria pior que falhar.
    throw new PlatformApiError(
      `A Meta precisa buscar "${midia.filename}" numa URL acessível publicamente, e ` +
        `nenhuma foi fornecida. Verifique a configuração do storage.`,
      { retryable: false, platform: 'Instagram' },
    );
  }

  const ehVideo = midia.mimeType.startsWith('video/');

  const resposta = await graphRequest<ContainerResponse>({
    method: 'POST',
    path: `/${contaId}/media`,
    params: {
      ...(ehVideo
        ? { video_url: midia.publicUrl, media_type: 'REELS' }
        : { image_url: midia.publicUrl }),
      ...(opcoes.legenda ? { caption: opcoes.legenda } : {}),
      ...(opcoes.carrosselItem ? { is_carousel_item: true } : {}),
    },
    accessToken: opcoes.accessToken,
    apiVersion: opcoes.apiVersion,
    ctx: opcoes.ctx,
  });

  if (!resposta.id) {
    throw new PlatformApiError(
      `O Instagram não devolveu o id do contêiner para "${midia.filename}".`,
      { retryable: true, platform: 'Instagram' },
    );
  }

  return resposta.id;
}

/**
 * A conta do Instagram é identificada pelo `remoteId` da conta conectada, que
 * o worker passa em `platformFields`. É o mesmo id que o OAuth resolveu.
 */
function extrairContaId(input: PublishInput): string {
  const valor = input.platformFields['__remoteAccountId'];

  if (typeof valor !== 'string' || valor.length === 0) {
    throw new PlatformApiError(
      'O identificador da conta do Instagram não foi informado na publicação.',
      { retryable: false, platform: 'Instagram' },
    );
  }

  return valor;
}

function montarLegenda(input: PublishInput): string {
  const hashtags = input.hashtags
    .map((tag) => `#${tag.replace(/^#/, '')}`)
    .join(' ');

  return [input.body, hashtags]
    .filter((parte) => parte.trim().length > 0)
    .join('\n\n')
    .slice(0, 2200);
}
