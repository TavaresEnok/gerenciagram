import {
  PlatformApiError,
  type AdapterContext,
  type PlatformCredentials,
  type RemoteComment,
  type SocialInbox,
} from '@app/core';
import { graphRequest } from './http.js';

/**
 * Comentários no Instagram e no Facebook.
 *
 * Os dois usam a Graph API, mas o caminho para responder é diferente:
 * no Instagram a resposta vai em `/{comment-id}/replies`; no Facebook, em
 * `/{comment-id}/comments`. Detalhe pequeno e fácil de errar — daí estarem
 * em funções separadas em vez de um parâmetro.
 */

interface ComentariosResponse {
  data?: Array<{
    id: string;
    text?: string;
    message?: string;
    timestamp?: string;
    created_time?: string;
    username?: string;
    from?: { id?: string; name?: string };
    parent?: { id?: string };
  }>;
}

function mapear(
  itens: ComentariosResponse['data'],
  remotePostId: string,
): RemoteComment[] {
  return (itens ?? []).map((item) => {
    const comentario: RemoteComment = {
      remoteId: item.id,
      body: item.text ?? item.message ?? '',
      postedAt: new Date(item.timestamp ?? item.created_time ?? Date.now()),
      remotePostId,
      raw: item,
    };

    // O Instagram devolve `username`; o Facebook, `from.name`.
    const autor = item.username ?? item.from?.name;
    if (autor) comentario.authorUsername = autor;
    if (item.from?.id) comentario.authorRemoteId = item.from.id;
    if (item.parent?.id) comentario.remoteParentId = item.parent.id;

    return comentario;
  });
}

export function createInstagramInbox(apiVersion: string): SocialInbox {
  return {
    async fetchComments(
      credentials: PlatformCredentials,
      remotePostId: string,
      ctx: AdapterContext,
    ): Promise<RemoteComment[]> {
      const resposta = await graphRequest<ComentariosResponse>({
        path: `/${remotePostId}/comments`,
        params: { fields: 'id,text,timestamp,username,parent{id}', limit: 100 },
        accessToken: credentials.accessToken,
        apiVersion,
        ctx,
      });

      return mapear(resposta.data, remotePostId);
    },

    async replyToComment(
      credentials: PlatformCredentials,
      remoteCommentId: string,
      body: string,
      ctx: AdapterContext,
    ): Promise<{ remoteId: string }> {
      const resposta = await graphRequest<{ id?: string }>({
        method: 'POST',
        path: `/${remoteCommentId}/replies`,
        params: { message: body },
        accessToken: credentials.accessToken,
        apiVersion,
        ctx,
      });

      if (!resposta.id) {
        throw new PlatformApiError(
          'O Instagram não devolveu o id da resposta publicada.',
          { retryable: true, platform: 'Instagram' },
        );
      }

      return { remoteId: resposta.id };
    },
  };
}

export function createFacebookInbox(apiVersion: string): SocialInbox {
  return {
    async fetchComments(
      credentials: PlatformCredentials,
      remotePostId: string,
      ctx: AdapterContext,
    ): Promise<RemoteComment[]> {
      const resposta = await graphRequest<ComentariosResponse>({
        path: `/${remotePostId}/comments`,
        params: { fields: 'id,message,created_time,from{id,name},parent{id}', limit: 100 },
        accessToken: credentials.accessToken,
        apiVersion,
        ctx,
      });

      return mapear(resposta.data, remotePostId);
    },

    async replyToComment(
      credentials: PlatformCredentials,
      remoteCommentId: string,
      body: string,
      ctx: AdapterContext,
    ): Promise<{ remoteId: string }> {
      const resposta = await graphRequest<{ id?: string }>({
        method: 'POST',
        // No Facebook a resposta a um comentário é um comentário do
        // comentário — não existe endpoint `/replies`.
        path: `/${remoteCommentId}/comments`,
        params: { message: body },
        accessToken: credentials.accessToken,
        apiVersion,
        ctx,
      });

      if (!resposta.id) {
        throw new PlatformApiError('O Facebook não devolveu o id da resposta publicada.', {
          retryable: true,
          platform: 'Facebook',
        });
      }

      return { remoteId: resposta.id };
    },
  };
}
