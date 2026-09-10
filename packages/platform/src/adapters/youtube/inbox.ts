import {
  PlatformApiError,
  type AdapterContext,
  type PlatformCredentials,
  type RemoteComment,
  type SocialInbox,
} from '@app/core';
import { googleRequest } from './http.js';

/**
 * Inbox de comentários do YouTube.
 *
 * Escopo: ler comentários precisa de `youtube.readonly`; RESPONDER precisa de
 * `youtube.force-ssl`, que não é pedido na conexão padrão (menor privilégio,
 * SPEC seção 10). Verificamos o escopo antes de tentar, para o usuário
 * receber "reconecte concedendo permissão de resposta" em vez de um 403 cru.
 */

const THREADS_URL = 'https://www.googleapis.com/youtube/v3/commentThreads';
const COMMENTS_URL = 'https://www.googleapis.com/youtube/v3/comments';
const REPLY_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';

interface CommentThreadResponse {
  items?: Array<{
    id: string;
    snippet?: {
      videoId?: string;
      topLevelComment?: {
        id: string;
        snippet?: {
          textDisplay?: string;
          textOriginal?: string;
          authorDisplayName?: string;
          authorProfileImageUrl?: string;
          authorChannelId?: { value?: string };
          publishedAt?: string;
        };
      };
    };
  }>;
  nextPageToken?: string;
}

export function createYouTubeInbox(): SocialInbox {
  return {
    async fetchComments(
      credentials: PlatformCredentials,
      remotePostId: string,
      ctx: AdapterContext,
    ): Promise<RemoteComment[]> {
      const url = new URL(THREADS_URL);
      url.searchParams.set('part', 'snippet');
      url.searchParams.set('videoId', remotePostId);
      url.searchParams.set('maxResults', '100');
      url.searchParams.set('order', 'time');

      const response = await googleRequest<CommentThreadResponse>({
        url: url.toString(),
        accessToken: credentials.accessToken,
        ctx,
      });

      const comments: RemoteComment[] = [];

      for (const thread of response.items ?? []) {
        const top = thread.snippet?.topLevelComment;
        const snippet = top?.snippet;
        if (!top || !snippet) continue;

        const comment: RemoteComment = {
          remoteId: top.id,
          body: snippet.textOriginal ?? snippet.textDisplay ?? '',
          postedAt: snippet.publishedAt ? new Date(snippet.publishedAt) : new Date(),
          raw: thread,
        };

        if (thread.snippet?.videoId) comment.remotePostId = thread.snippet.videoId;
        if (snippet.authorChannelId?.value) comment.authorRemoteId = snippet.authorChannelId.value;
        if (snippet.authorDisplayName) comment.authorUsername = snippet.authorDisplayName;
        if (snippet.authorProfileImageUrl) comment.authorAvatarUrl = snippet.authorProfileImageUrl;

        comments.push(comment);
      }

      return comments;
    },

    async replyToComment(
      credentials: PlatformCredentials,
      remoteCommentId: string,
      body: string,
      ctx: AdapterContext,
    ): Promise<{ remoteId: string }> {
      if (!credentials.scopes.includes(REPLY_SCOPE)) {
        throw new PlatformApiError(
          'Esta conta foi conectada apenas com permissão de leitura. Para responder ' +
            'comentários no YouTube, reconecte a conta concedendo a permissão de gestão.',
          { retryable: false, platform: 'YouTube' },
        );
      }

      const url = new URL(COMMENTS_URL);
      url.searchParams.set('part', 'snippet');

      const response = await googleRequest<{ id?: string }>({
        method: 'POST',
        url: url.toString(),
        accessToken: credentials.accessToken,
        body: { snippet: { parentId: remoteCommentId, textOriginal: body } },
        ctx,
      });

      if (!response.id) {
        throw new PlatformApiError('O YouTube não devolveu o id da resposta publicada.', {
          retryable: true,
          platform: 'YouTube',
        });
      }

      return { remoteId: response.id };
    },
  };
}
