import {
  PlatformApiError,
  UnsupportedByPlatformError,
  withTimeout,
  type AdapterContext,
  type DynamicFieldOptions,
  type PlatformCredentials,
  type PublishInput,
  type PublishResult,
  type RemotePostState,
  type SocialPublisher,
} from '@app/core';
import { googleRequest, rawGoogleRequest } from './http.js';

/**
 * Publicação no YouTube via protocolo de upload retomável.
 *
 * Referências oficiais consultadas em 2026-09-10:
 *   https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
 *   https://developers.google.com/youtube/v3/docs/videos/insert
 *
 * Por que retomável e em pedaços, e não um POST único: vídeo é arquivo
 * grande, a SPEC (seção 21) exige tratar "upload interrompido", e o protocolo
 * retomável é o único caminho oficial para continuar de onde parou em vez de
 * reenviar o arquivo inteiro a cada tentativa.
 */

const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';
const VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos';
const CATEGORIES_URL = 'https://www.googleapis.com/youtube/v3/videoCategories';

const PLATFORM = 'YouTube';

/**
 * O Google exige que cada pedaço (exceto o último) seja múltiplo de 256 KB.
 * 8 MB equilibra número de requisições e quanto se perde ao reenviar um
 * pedaço que falhou.
 */
const CHUNK_SIZE = 8 * 1024 * 1024;

interface VideoResource {
  id?: string;
  snippet?: { title?: string; channelId?: string };
  status?: {
    uploadStatus?: string;
    privacyStatus?: string;
    rejectionReason?: string;
    failureReason?: string;
  };
  processingDetails?: { processingStatus?: string };
}

interface CategoryListResponse {
  items?: Array<{ id: string; snippet?: { title?: string; assignable?: boolean } }>;
}

export function createYouTubePublisher(): SocialPublisher {
  return {
    async publish(
      credentials: PlatformCredentials,
      input: PublishInput,
      ctx: AdapterContext,
    ): Promise<PublishResult> {
      const media = input.media[0];
      if (!media) {
        throw new PlatformApiError('O YouTube exige um arquivo de vídeo para publicar.', {
          retryable: false,
          platform: PLATFORM,
        });
      }
      if (input.media.length > 1) {
        throw new UnsupportedByPlatformError(PLATFORM, 'publicar várias mídias em um post');
      }

      const metadata = buildVideoResource(input);

      const sessionUri = await initiateUpload(credentials, metadata, media, ctx);
      ctx.logger.debug('sessão de upload do YouTube criada', {
        correlationId: ctx.correlationId,
        sizeBytes: media.sizeBytes,
      });

      const video = await uploadInChunks(credentials, sessionUri, media, ctx);

      if (!video.id) {
        throw new PlatformApiError(
          'O YouTube aceitou o upload mas não devolveu o id do vídeo.',
          { retryable: true, platform: PLATFORM },
        );
      }

      const uploadStatus = video.status?.uploadStatus;

      return {
        remoteId: video.id,
        remoteUrl: `https://www.youtube.com/watch?v=${video.id}`,
        // `uploaded` significa recebido, não publicado: o YouTube ainda
        // transcodifica. Quem confirma é o job de verificação de estado.
        processingPending: uploadStatus === 'uploaded' || uploadStatus === undefined,
        raw: video,
      };
    },

    async fetchRemoteState(
      credentials: PlatformCredentials,
      remoteId: string,
      ctx: AdapterContext,
    ): Promise<RemotePostState> {
      const url = new URL(VIDEOS_URL);
      url.searchParams.set('part', 'status,processingDetails');
      url.searchParams.set('id', remoteId);

      const response = await googleRequest<{ items?: VideoResource[] }>({
        url: url.toString(),
        accessToken: credentials.accessToken,
        ctx,
      });

      const video = response.items?.[0];
      if (!video) {
        return { remoteId, status: 'DELETED' };
      }

      const uploadStatus = video.status?.uploadStatus;
      const rejection = video.status?.rejectionReason ?? video.status?.failureReason;

      if (uploadStatus === 'rejected' || uploadStatus === 'failed') {
        return {
          remoteId,
          status: 'REJECTED',
          ...(rejection ? { rejectionReason: rejection } : {}),
        };
      }
      if (uploadStatus === 'deleted') return { remoteId, status: 'DELETED' };
      if (uploadStatus === 'processed') {
        return {
          remoteId,
          status: 'READY',
          remoteUrl: `https://www.youtube.com/watch?v=${remoteId}`,
        };
      }

      return { remoteId, status: 'PROCESSING' };
    },

    async deletePost(
      credentials: PlatformCredentials,
      remoteId: string,
      ctx: AdapterContext,
    ): Promise<void> {
      const url = new URL(VIDEOS_URL);
      url.searchParams.set('id', remoteId);

      await googleRequest<void>({
        method: 'DELETE',
        url: url.toString(),
        accessToken: credentials.accessToken,
        ctx,
        raw: true,
      });
    },

    /**
     * As categorias variam por região e mudam com o tempo. Buscá-las na API
     * é o que impede a lista fixa que a SPEC seção 19 chama de invenção.
     */
    async fetchDynamicFieldOptions(
      credentials: PlatformCredentials,
      ctx: AdapterContext,
    ): Promise<DynamicFieldOptions[]> {
      const url = new URL(CATEGORIES_URL);
      url.searchParams.set('part', 'snippet');
      url.searchParams.set('regionCode', 'BR');

      const response = await googleRequest<CategoryListResponse>({
        url: url.toString(),
        accessToken: credentials.accessToken,
        ctx,
      });

      const options = (response.items ?? [])
        // Categorias não atribuíveis existem no catálogo mas o upload rejeita.
        .filter((item) => item.snippet?.assignable === true)
        .map((item) => ({ value: item.id, label: item.snippet?.title ?? item.id }));

      return [{ fieldKey: 'categoryId', options }];
    },
  };
}

// ---------------------------------------------------------------------------

function buildVideoResource(input: PublishInput): Record<string, unknown> {
  const fields = input.platformFields;

  const privacyStatus = typeof fields['privacyStatus'] === 'string' ? fields['privacyStatus'] : 'private';
  const categoryId = typeof fields['categoryId'] === 'string' ? fields['categoryId'] : undefined;
  const madeForKids = fields['madeForKids'] === true;

  const description = [input.body, input.hashtags.map((tag) => `#${tag.replace(/^#/, '')}`).join(' ')]
    .filter((part) => part.trim().length > 0)
    .join('\n\n');

  const status: Record<string, unknown> = {
    selfDeclaredMadeForKids: madeForKids,
  };

  if (input.publishAt) {
    // Exigência do YouTube: agendamento nativo só funciona com o vídeo
    // enviado como privado. Mandar `public` + `publishAt` faz o vídeo sair na
    // hora, ignorando o agendamento.
    status['privacyStatus'] = 'private';
    status['publishAt'] = input.publishAt.toISOString();
  } else {
    status['privacyStatus'] = privacyStatus;
  }

  return {
    snippet: {
      title: (input.title ?? '').slice(0, 100),
      description: description.slice(0, 5000),
      ...(input.hashtags.length > 0 ? { tags: input.hashtags.map((t) => t.replace(/^#/, '')) } : {}),
      ...(categoryId ? { categoryId } : {}),
    },
    status,
  };
}

async function initiateUpload(
  credentials: PlatformCredentials,
  metadata: Record<string, unknown>,
  media: PublishInput['media'][number],
  ctx: AdapterContext,
): Promise<string> {
  const url = new URL(UPLOAD_URL);
  url.searchParams.set('uploadType', 'resumable');
  url.searchParams.set('part', 'snippet,status');

  const response = await rawGoogleRequest({
    method: 'POST',
    url: url.toString(),
    accessToken: credentials.accessToken,
    body: metadata,
    headers: {
      'X-Upload-Content-Length': String(media.sizeBytes),
      'X-Upload-Content-Type': media.mimeType,
    },
    ctx,
  });

  const sessionUri = response.headers.get('location');
  if (!sessionUri) {
    throw new PlatformApiError(
      'O YouTube não devolveu a URI de sessão de upload (header Location).',
      { retryable: true, platform: PLATFORM },
    );
  }

  return sessionUri;
}

/**
 * Envia o arquivo em pedaços. Cada pedaço intermediário responde 308; o
 * último responde 200/201 com o recurso do vídeo.
 */
async function uploadInChunks(
  credentials: PlatformCredentials,
  sessionUri: string,
  media: PublishInput['media'][number],
  ctx: AdapterContext,
): Promise<VideoResource> {
  const total = media.sizeBytes;
  const stream = media.stream();

  let offset = 0;
  let buffer = Buffer.alloc(0);
  let finalVideo: VideoResource | null = null;

  const flush = async (chunk: Buffer, isLast: boolean): Promise<void> => {
    const start = offset;
    const end = offset + chunk.length - 1;

    const result = await putChunk(credentials, sessionUri, chunk, start, end, total, ctx);
    offset += chunk.length;

    if (isLast && result) finalVideo = result;
  };

  for await (const piece of stream as AsyncIterable<Buffer | string>) {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(piece) ? piece : Buffer.from(piece)]);

    while (buffer.length >= CHUNK_SIZE) {
      const chunk = buffer.subarray(0, CHUNK_SIZE);
      buffer = buffer.subarray(CHUNK_SIZE);
      const isLast = offset + chunk.length >= total;
      await flush(Buffer.from(chunk), isLast);
    }
  }

  if (buffer.length > 0) {
    await flush(buffer, true);
  }

  if (offset !== total) {
    throw new PlatformApiError(
      `Upload incompleto: enviados ${offset} de ${total} bytes. ` +
        `O arquivo no storage não bate com o tamanho registrado.`,
      { retryable: true, platform: PLATFORM },
    );
  }

  if (!finalVideo) {
    throw new PlatformApiError(
      'O YouTube não devolveu o recurso do vídeo ao final do upload.',
      { retryable: true, platform: PLATFORM },
    );
  }

  return finalVideo;
}

async function putChunk(
  credentials: PlatformCredentials,
  sessionUri: string,
  chunk: Buffer,
  start: number,
  end: number,
  total: number,
  ctx: AdapterContext,
): Promise<VideoResource | null> {
  // Cada pedaço tem seu próprio timeout: um arquivo de 2 GB não pode caber
  // no mesmo prazo de uma chamada de metadados.
  const { signal, cancel } = withTimeout(Math.max(ctx.timeoutMs, 120_000), ctx.signal);

  try {
    const response = await fetch(sessionUri, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        'Content-Length': String(chunk.length),
        'Content-Range': `bytes ${start}-${end}/${total}`,
      },
      body: new Uint8Array(chunk),
      signal,
    });

    // 308 = pedaço aceito, faltam outros.
    if (response.status === 308) {
      await response.text();
      return null;
    }

    const text = await response.text();

    if (!response.ok) {
      throw new PlatformApiError(
        `Falha ao enviar o pedaço ${start}-${end} para o YouTube (${response.status}): ${text.slice(0, 300)}`,
        {
          retryable: response.status >= 500 || response.status === 408,
          platform: PLATFORM,
          httpStatus: response.status,
        },
      );
    }

    return text ? (JSON.parse(text) as VideoResource) : null;
  } catch (error) {
    if (error instanceof PlatformApiError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new PlatformApiError(
        `Tempo esgotado ao enviar o pedaço ${start}-${end} do vídeo.`,
        { retryable: true, platform: PLATFORM },
      );
    }
    throw new PlatformApiError(
      `Falha de rede ao enviar o vídeo: ${error instanceof Error ? error.message : String(error)}`,
      { retryable: true, platform: PLATFORM, cause: error },
    );
  } finally {
    cancel();
  }
}

/**
 * Consulta quantos bytes o YouTube já recebeu numa sessão interrompida.
 * Usada pelo worker antes de re-tentar, para não reenviar o arquivo inteiro.
 */
export async function queryUploadOffset(
  credentials: PlatformCredentials,
  sessionUri: string,
  total: number,
  ctx: AdapterContext,
): Promise<number> {
  const { signal, cancel } = withTimeout(ctx.timeoutMs, ctx.signal);

  try {
    const response = await fetch(sessionUri, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        'Content-Range': `bytes */${total}`,
        'Content-Length': '0',
      },
      signal,
    });

    if (response.status === 200 || response.status === 201) return total;

    if (response.status === 308) {
      const range = response.headers.get('range');
      if (!range) return 0;
      const match = /bytes=0-(\d+)/.exec(range);
      return match?.[1] ? Number(match[1]) + 1 : 0;
    }

    throw new PlatformApiError(
      `Não foi possível consultar o progresso do upload (${response.status}).`,
      { retryable: true, platform: PLATFORM, httpStatus: response.status },
    );
  } finally {
    cancel();
  }
}
