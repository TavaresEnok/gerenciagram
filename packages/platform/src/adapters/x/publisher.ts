import {
  PlatformApiError,
  UnsupportedByPlatformError,
  withTimeout,
  type AdapterContext,
  type DynamicFieldOptions,
  type PlatformCredentials,
  type PublishInput,
  type PublishMediaInput,
  type PublishResult,
  type RemotePostState,
  type SocialPublisher,
} from '@app/core';
import { xRequest } from './http.js';

/**
 * Publicador oficial para o X (Twitter) via API v2.
 *
 * Fontes oficiais:
 *   https://docs.x.com/x-api/tweets/manage-tweets/api-reference/post-tweets
 *   https://docs.x.com/x-api/tweets/manage-tweets/api-reference/delete-tweets-id
 */

const PLATFORM = 'X';
const MAX_TWEET_CHARS = 280;
const UPLOAD_HOST = 'https://upload.twitter.com/1.1/media/upload.json';

interface CreateTweetResponse {
  data?: {
    id?: string;
    text?: string;
  };
}

interface DeleteTweetResponse {
  data?: {
    deleted?: boolean;
  };
}

interface MediaInitResponse {
  media_id_string?: string;
}

interface MediaFinalizeResponse {
  media_id_string?: string;
  processing_info?: {
    state?: 'pending' | 'in_progress' | 'succeeded' | 'failed';
    check_after_secs?: number;
    error?: { message?: string };
  };
}

export function createXPublisher(): SocialPublisher {
  return {
    async publish(
      credentials: PlatformCredentials,
      input: PublishInput,
      ctx: AdapterContext,
    ): Promise<PublishResult> {
      if (input.publishAt) {
        throw new UnsupportedByPlatformError(PLATFORM, 'agendamento nativo');
      }

      const texto = montarTextoTweet(input);
      const mediaIds: string[] = [];

      if (input.media && input.media.length > 0) {
        if (input.media.length > 4) {
          throw new PlatformApiError('O X permite no máximo 4 imagens por publicação.', {
            platform: PLATFORM,
            retryable: false,
          });
        }

        const temVideo = input.media.some((m) => m.mimeType.startsWith('video/'));
        if (temVideo && input.media.length > 1) {
          throw new PlatformApiError('O X permite apenas 1 vídeo por publicação.', {
            platform: PLATFORM,
            retryable: false,
          });
        }

        for (const midia of input.media) {
          const mediaId = await uploadMedia(credentials, midia, ctx);
          mediaIds.push(mediaId);
        }
      }

      if (!texto && mediaIds.length === 0) {
        throw new PlatformApiError('O X exige texto ou pelo menos uma mídia para publicar.', {
          platform: PLATFORM,
          retryable: false,
        });
      }

      const body: Record<string, unknown> = {};
      if (texto) body.text = texto;
      if (mediaIds.length > 0) {
        body.media = { media_ids: mediaIds };
      }

      const resp = await xRequest<CreateTweetResponse>({
        path: '/2/tweets',
        accessToken: credentials.accessToken,
        method: 'POST',
        body,
        ctx,
      });

      const tweetId = resp.data?.id;
      if (!tweetId) {
        throw new PlatformApiError('O X aceitou a publicação mas não devolveu o ID do tweet.', {
          platform: PLATFORM,
          retryable: true,
        });
      }

      return {
        remoteId: tweetId,
        remoteUrl: `https://x.com/i/status/${tweetId}`,
        processingPending: false,
        raw: resp,
      };
    },

    async deletePost(
      credentials: PlatformCredentials,
      remoteId: string,
      ctx: AdapterContext,
    ): Promise<void> {
      const resp = await xRequest<DeleteTweetResponse>({
        path: `/2/tweets/${remoteId}`,
        accessToken: credentials.accessToken,
        method: 'DELETE',
        ctx,
      });

      if (resp.data && resp.data.deleted === false) {
        throw new PlatformApiError('A API do X não confirmou a exclusão do tweet.', {
          platform: PLATFORM,
          retryable: false,
        });
      }
    },

    async fetchRemoteState(
      _credentials: PlatformCredentials,
      remoteId: string,
    ): Promise<RemotePostState> {
      return {
        remoteId,
        status: 'READY',
        remoteUrl: `https://x.com/i/status/${remoteId}`,
      };
    },

    async fetchDynamicFieldOptions(
      _credentials: PlatformCredentials,
      _ctx: AdapterContext,
    ): Promise<DynamicFieldOptions[]> {
      // O X não possui campos dinâmicos dependentes de conta/região
      return [];
    },
  };
}

export function montarTextoTweet(input: PublishInput): string {
  const hashtags = (input.hashtags ?? []).map((t) => `#${t.replace(/^#/, '')}`).join(' ');
  const partes = [input.body, hashtags].filter((p) => p && p.trim().length > 0);
  const texto = partes.join('\n\n').trim();

  return texto.slice(0, MAX_TWEET_CHARS);
}

async function lerBuffer(streamFn: () => NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of streamFn() as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function uploadMedia(
  credentials: PlatformCredentials,
  midia: PublishMediaInput,
  ctx: AdapterContext,
): Promise<string> {
  let bytes: Buffer;

  if (midia.stream) {
    bytes = await lerBuffer(midia.stream);
  } else if (midia.publicUrl) {
    const { signal, cancel } = withTimeout(ctx.timeoutMs, ctx.signal);
    try {
      const resp = await fetch(midia.publicUrl, { signal });
      if (!resp.ok) {
        throw new Error(`Download da mídia retornou status ${resp.status}`);
      }
      const arrayBuffer = await resp.arrayBuffer();
      bytes = Buffer.from(arrayBuffer);
    } catch (err) {
      throw new PlatformApiError(`Falha ao obter mídia para envio ao X: ${err instanceof Error ? err.message : String(err)}`, {
        platform: PLATFORM,
        retryable: true,
        cause: err,
      });
    } finally {
      cancel();
    }
  } else {
    throw new PlatformApiError('Mídia sem stream ou URL para envio ao X.', {
      platform: PLATFORM,
      retryable: false,
    });
  }

  const isVideo = midia.mimeType.startsWith('video/');
  const mediaCategory = isVideo ? 'tweet_video' : 'tweet_image';

  // 1. INIT
  const initParams = new URLSearchParams({
    command: 'INIT',
    total_bytes: bytes.length.toString(),
    media_type: midia.mimeType,
    media_category: mediaCategory,
  });

  const initResp = await chamarUpload<MediaInitResponse>(credentials, initParams, ctx);
  const mediaId = initResp.media_id_string;

  if (!mediaId) {
    throw new PlatformApiError('A API do X não retornou media_id_string na inicialização do upload.', {
      platform: PLATFORM,
      retryable: true,
    });
  }

  // 2. APPEND
  const formData = new FormData();
  formData.append('command', 'APPEND');
  formData.append('media_id', mediaId);
  formData.append('segment_index', '0');
  formData.append('media', new Blob([bytes], { type: midia.mimeType }));

  const { signal: appendSignal, cancel: cancelAppend } = withTimeout(ctx.timeoutMs, ctx.signal);
  try {
    const appendResp = await fetch(UPLOAD_HOST, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
      },
      body: formData,
      signal: appendSignal,
    });

    if (!appendResp.ok && appendResp.status !== 204) {
      const errTxt = await appendResp.text();
      throw new PlatformApiError(`Falha no envio do arquivo ao X (APPEND): ${errTxt}`, {
        platform: PLATFORM,
        httpStatus: appendResp.status,
        retryable: true,
      });
    }
  } finally {
    cancelAppend();
  }

  // 3. FINALIZE
  const finalizeParams = new URLSearchParams({
    command: 'FINALIZE',
    media_id: mediaId,
  });

  const finalizeResp = await chamarUpload<MediaFinalizeResponse>(credentials, finalizeParams, ctx);

  // 4. STATUS (se aplicável para vídeo com processamento assíncrono)
  if (finalizeResp.processing_info) {
    let state = finalizeResp.processing_info.state;
    let attempts = 0;
    const maxAttempts = 15;

    while (state === 'pending' || state === 'in_progress') {
      attempts++;
      if (attempts > maxAttempts) break;

      const waitSec = finalizeResp.processing_info.check_after_secs ?? 2;
      await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));

      const statusParams = new URLSearchParams({
        command: 'STATUS',
        media_id: mediaId,
      });

      const statusResp = await chamarUpload<MediaFinalizeResponse>(credentials, statusParams, ctx);
      state = statusResp.processing_info?.state;

      if (state === 'failed') {
        throw new PlatformApiError(`Processamento do vídeo recusado pelo X: ${statusResp.processing_info?.error?.message ?? 'erro desconhecido'}`, {
          platform: PLATFORM,
          retryable: false,
        });
      }
    }
  }

  return mediaId;
}

async function chamarUpload<T>(
  credentials: PlatformCredentials,
  params: URLSearchParams,
  ctx: AdapterContext,
): Promise<T> {
  const { signal, cancel } = withTimeout(ctx.timeoutMs, ctx.signal);

  try {
    const resp = await fetch(`${UPLOAD_HOST}?${params.toString()}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
      },
      signal,
    });

    if (!resp.ok) {
      const texto = await resp.text();
      throw new PlatformApiError(`Falha na API de upload do X: ${texto || resp.statusText}`, {
        platform: PLATFORM,
        httpStatus: resp.status,
        retryable: resp.status >= 500,
      });
    }

    return (await resp.json()) as T;
  } finally {
    cancel();
  }
}
