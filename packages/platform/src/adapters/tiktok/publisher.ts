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
import { tiktokRequest } from './http.js';

/**
 * Content Posting API do TikTok — Direct Post.
 *
 * Fontes oficiais consultadas em 2026-09-11:
 *   https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
 *   https://developers.tiktok.com/doc/content-posting-api-get-started
 *   https://developers.tiktok.com/doc/content-sharing-guidelines
 *
 * O fluxo tem três passos e nenhum deles pode ser pulado:
 *
 *   1. `video/init/` declara os metadados e o tamanho do arquivo, e devolve
 *      `publish_id` + `upload_url` (válida por 1 hora).
 *   2. o arquivo sobe em pedaços por PUT na `upload_url`.
 *   3. `status/fetch/` confirma se o TikTok terminou de processar — o
 *      `publish_id` NÃO é o id do post, e só depois de PUBLISH_COMPLETE
 *      existe um `publicaly_available_post_id`.
 *
 * O que este adapter se recusa a fazer, por exigência das Content Sharing
 * Guidelines (SPEC seção 6.1):
 *   - escolher um `privacy_level` por conta do usuário — não há padrão;
 *   - publicar sem o consentimento de uso de música confirmado.
 * Em ambos os casos ele falha de forma explícita em vez de assumir um valor.
 */

const PLATFORM = 'TikTok';

/**
 * Regras de fatiamento do TikTok: cada pedaço tem de ter entre 5 MB e 64 MB,
 * no máximo 1000 pedaços, e o ÚLTIMO carrega o resto da divisão (por isso
 * `total_chunk_count` é o piso, não o teto arredondado). Arquivo de até 64 MB
 * vai inteiro, num pedaço só.
 */
const MIN_CHUNK = 5 * 1024 * 1024;
const MAX_CHUNK = 64 * 1024 * 1024;
const MAX_CHUNKS = 1000;

/** Limite documentado do título/legenda, em runes UTF-16. */
const MAX_TITLE_RUNES = 2200;

interface InitResponse {
  data?: { publish_id?: string; upload_url?: string };
}

interface StatusResponse {
  data?: {
    status?: string;
    fail_reason?: string;
    publicaly_available_post_id?: string[];
    uploaded_bytes?: number;
  };
}

interface CreatorInfoResponse {
  data?: {
    creator_nickname?: string;
    creator_username?: string;
    privacy_level_options?: string[];
    comment_disabled?: boolean;
    duet_disabled?: boolean;
    stitch_disabled?: boolean;
    max_video_post_duration_sec?: number;
  };
}

export function createTikTokPublisher(): SocialPublisher {
  return {
    async publish(
      credentials: PlatformCredentials,
      input: PublishInput,
      ctx: AdapterContext,
    ): Promise<PublishResult> {
      const midia = input.media[0];
      if (!midia) {
        throw new PlatformApiError('O TikTok exige pelo menos um arquivo para publicar.', {
          retryable: false,
          platform: PLATFORM,
        });
      }

      if (input.publishAt) {
        // A capacidade declarada no registro é UNSUPPORTED; se um chamador
        // insistir, é melhor gritar do que publicar na hora errada.
        throw new UnsupportedByPlatformError(PLATFORM, 'agendamento nativo');
      }

      const postInfo = buildPostInfo(input);

      return midia.mimeType.startsWith('image/')
        ? publicarFotos(credentials, input, postInfo, ctx)
        : publicarVideo(credentials, midia, postInfo, ctx);
    },

    async fetchRemoteState(
      credentials: PlatformCredentials,
      remoteId: string,
      ctx: AdapterContext,
    ): Promise<RemotePostState> {
      const resposta = await tiktokRequest<StatusResponse>({
        path: '/v2/post/publish/status/fetch/',
        accessToken: credentials.accessToken,
        body: { publish_id: remoteId },
        ctx,
      });

      return interpretarStatus(remoteId, resposta);
    },

    async deletePost(): Promise<void> {
      // A Content Posting API não expõe exclusão — é o que o registro declara
      // em `capabilities.deletePost`. Fingir sucesso aqui faria o sistema
      // marcar como apagado um vídeo que continua no ar.
      throw new UnsupportedByPlatformError(PLATFORM, 'excluir publicação');
    },

    /**
     * `creator_info/query` é obrigatório antes de qualquer publicação: os
     * níveis de privacidade variam por conta (uma conta privada não oferece
     * PUBLIC_TO_EVERYONE) e as Content Sharing Guidelines exigem mostrar ao
     * usuário exatamente as opções que aquela conta permite. É por isso que o
     * registro marca `privacy_level` como `optionsFromApi` com lista vazia.
     */
    async fetchDynamicFieldOptions(
      credentials: PlatformCredentials,
      ctx: AdapterContext,
    ): Promise<DynamicFieldOptions[]> {
      const info = await consultarCreatorInfo(credentials, ctx);
      const dados = info.data ?? {};

      const opcoes: DynamicFieldOptions[] = [
        {
          fieldKey: 'privacy_level',
          options: (dados.privacy_level_options ?? []).map((valor) => ({
            value: valor,
            label: rotuloDePrivacidade(valor),
          })),
        },
      ];

      // Quando a conta já desativou interações no perfil, o TikTok recusa o
      // post se pedirmos o contrário. Expor isso como opção única evita
      // oferecer ao usuário uma escolha que a API vai rejeitar.
      if (dados.comment_disabled === true) {
        opcoes.push({ fieldKey: 'disable_comment', options: [{ value: 'true', label: 'Sim' }] });
      }
      if (dados.duet_disabled === true) {
        opcoes.push({ fieldKey: 'disable_duet', options: [{ value: 'true', label: 'Sim' }] });
      }
      if (dados.stitch_disabled === true) {
        opcoes.push({ fieldKey: 'disable_stitch', options: [{ value: 'true', label: 'Sim' }] });
      }

      return opcoes;
    },
  };
}

// ---------------------------------------------------------------------------
//  Metadados
// ---------------------------------------------------------------------------

export function buildPostInfo(input: PublishInput): Record<string, unknown> {
  const campos = input.platformFields ?? {};

  const privacyLevel = campos['privacy_level'];
  if (typeof privacyLevel !== 'string' || privacyLevel.length === 0) {
    throw new PlatformApiError(
      'O TikTok exige que o usuário escolha o nível de privacidade, e as diretrizes de ' +
        'compartilhamento proíbem um valor padrão. Selecione a privacidade antes de publicar.',
      { retryable: false, platform: PLATFORM },
    );
  }

  // Consentimento de uso de música: campo CONSENT obrigatório no registro.
  // Publicar sem ele violaria as Content Sharing Guidelines.
  if (campos['music_usage_consent'] !== true) {
    throw new PlatformApiError(
      'É preciso confirmar a Confirmação de Uso de Música do TikTok antes de publicar.',
      { retryable: false, platform: PLATFORM },
    );
  }

  const brandContent = campos['brand_content_toggle'] === true;
  const brandOrganic = campos['brand_organic_toggle'] === true;

  // Regra explícita do TikTok: conteúdo de marca não pode ser publicado como
  // SELF_ONLY. Deixar passar renderia erro remoto sem explicação.
  if (brandContent && privacyLevel === 'SELF_ONLY') {
    throw new PlatformApiError(
      'O TikTok não permite marcar conteúdo de marca (Branded Content) num vídeo privado ' +
        '(SELF_ONLY). Escolha outro nível de privacidade ou desmarque o conteúdo de marca.',
      { retryable: false, platform: PLATFORM },
    );
  }

  const info: Record<string, unknown> = {
    title: montarTitulo(input),
    privacy_level: privacyLevel,
    disable_comment: campos['disable_comment'] === true,
    brand_content_toggle: brandContent,
    brand_organic_toggle: brandOrganic,
  };

  // Duet e Stitch só existem para vídeo; mandá-los num photo post é
  // parâmetro inválido.
  const temVideo = input.media.some((m) => !m.mimeType.startsWith('image/'));
  if (temVideo) {
    info['disable_duet'] = campos['disable_duet'] === true;
    info['disable_stitch'] = campos['disable_stitch'] === true;

    const capa = campos['video_cover_timestamp_ms'];
    if (typeof capa === 'number' && Number.isFinite(capa) && capa >= 0) {
      info['video_cover_timestamp_ms'] = Math.floor(capa);
    }
  }

  if (campos['is_aigc'] === true) info['is_aigc'] = true;

  return info;
}

/**
 * O TikTok conta o título em runes UTF-16 e não tem campo de descrição
 * separado: legenda e hashtags vão juntas.
 */
function montarTitulo(input: PublishInput): string {
  const hashtags = input.hashtags.map((tag) => `#${tag.replace(/^#/, '')}`).join(' ');
  const texto = [input.body, hashtags].filter((parte) => parte.trim().length > 0).join('\n\n');

  // `slice` opera em unidades UTF-16, que é exatamente a contagem do TikTok.
  return texto.slice(0, MAX_TITLE_RUNES);
}

// ---------------------------------------------------------------------------
//  Vídeo — FILE_UPLOAD em pedaços
// ---------------------------------------------------------------------------

async function publicarVideo(
  credentials: PlatformCredentials,
  midia: PublishMediaInput,
  postInfo: Record<string, unknown>,
  ctx: AdapterContext,
): Promise<PublishResult> {
  const plano = planejarPedacos(midia.sizeBytes);

  const init = await tiktokRequest<InitResponse>({
    path: '/v2/post/publish/video/init/',
    accessToken: credentials.accessToken,
    body: {
      post_info: postInfo,
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: midia.sizeBytes,
        chunk_size: plano.chunkSize,
        total_chunk_count: plano.totalChunks,
      },
    },
    ctx,
  });

  const publishId = init.data?.publish_id;
  const uploadUrl = init.data?.upload_url;

  if (!publishId || !uploadUrl) {
    throw new PlatformApiError(
      'O TikTok aceitou a inicialização mas não devolveu publish_id/upload_url.',
      { retryable: true, platform: PLATFORM },
    );
  }

  ctx.logger.debug('sessão de upload do TikTok criada', {
    correlationId: ctx.correlationId,
    sizeBytes: midia.sizeBytes,
    totalChunks: plano.totalChunks,
  });

  await enviarPedacos(uploadUrl, midia, plano, ctx);

  return {
    // O publish_id é o que temos AGORA; o id público do post só aparece
    // depois do processamento, via fetchRemoteState.
    remoteId: publishId,
    processingPending: true,
    raw: init.data,
  };
}

export interface PlanoDePedacos {
  chunkSize: number;
  totalChunks: number;
}

/**
 * Calcula o fatiamento nas regras do TikTok.
 *
 * O ponto que engana: `total_chunk_count` é `floor(tamanho / chunk_size)`, e
 * o último pedaço leva o resto — ele pode ter até quase o dobro do
 * `chunk_size`. Arredondar para cima faria o TikTok esperar um pedaço a mais
 * que nunca chega, e o upload ficaria pendurado até expirar.
 */
export function planejarPedacos(sizeBytes: number): PlanoDePedacos {
  if (sizeBytes <= 0) {
    throw new PlatformApiError('Arquivo de vídeo vazio: não há o que enviar ao TikTok.', {
      retryable: false,
      platform: PLATFORM,
    });
  }

  // Até 64 MB o arquivo vai inteiro — é o que a documentação chama de
  // "whole file upload".
  if (sizeBytes <= MAX_CHUNK) {
    return { chunkSize: sizeBytes, totalChunks: 1 };
  }

  let chunkSize = MAX_CHUNK;
  let totalChunks = Math.floor(sizeBytes / chunkSize);

  // Acima de 1000 pedaços o TikTok recusa. Com o teto de 64 MB por pedaço,
  // isso só aconteceria acima de ~64 GB — bem além do limite de 4 GB do
  // registro —, mas a checagem fica porque o limite é dele, não nosso.
  if (totalChunks > MAX_CHUNKS) {
    throw new PlatformApiError(
      `Vídeo grande demais para o TikTok: exigiria ${totalChunks} pedaços, e o máximo é ${MAX_CHUNKS}.`,
      { retryable: false, platform: PLATFORM },
    );
  }

  if (chunkSize < MIN_CHUNK) chunkSize = MIN_CHUNK;
  totalChunks = Math.floor(sizeBytes / chunkSize);

  return { chunkSize, totalChunks };
}

async function enviarPedacos(
  uploadUrl: string,
  midia: PublishMediaInput,
  plano: PlanoDePedacos,
  ctx: AdapterContext,
): Promise<void> {
  const total = midia.sizeBytes;
  const stream = midia.stream();

  let offset = 0;
  let buffer = Buffer.alloc(0);
  let enviados = 0;

  const enviar = async (pedaco: Buffer): Promise<void> => {
    await putPedaco(uploadUrl, midia.mimeType, pedaco, offset, offset + pedaco.length - 1, total, ctx);
    offset += pedaco.length;
    enviados += 1;
  };

  for await (const parte of stream as AsyncIterable<Buffer | string>) {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(parte) ? parte : Buffer.from(parte)]);

    // Só corta enquanto ainda houver pedaço de tamanho fixo pela frente; o
    // último (que carrega o resto) sai fora do laço, inteiro.
    while (enviados < plano.totalChunks - 1 && buffer.length >= plano.chunkSize) {
      const pedaco = Buffer.from(buffer.subarray(0, plano.chunkSize));
      buffer = buffer.subarray(plano.chunkSize);
      await enviar(pedaco);
    }
  }

  if (buffer.length > 0) await enviar(buffer);

  if (offset !== total) {
    throw new PlatformApiError(
      `Upload incompleto para o TikTok: enviados ${offset} de ${total} bytes. ` +
        'O arquivo no storage não bate com o tamanho registrado.',
      { retryable: true, platform: PLATFORM },
    );
  }
}

async function putPedaco(
  uploadUrl: string,
  mimeType: string,
  pedaco: Buffer,
  inicio: number,
  fim: number,
  total: number,
  ctx: AdapterContext,
): Promise<void> {
  // Um pedaço de 64 MB não cabe no mesmo prazo de uma chamada de metadados.
  const { signal, cancel } = withTimeout(Math.max(ctx.timeoutMs, 120_000), ctx.signal);

  try {
    const resposta = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(pedaco.length),
        'Content-Range': `bytes ${inicio}-${fim}/${total}`,
      },
      body: new Uint8Array(pedaco),
      signal,
    });

    // 206 = pedaço aceito, faltam outros. 201 = arquivo completo.
    if (resposta.ok) {
      await resposta.text();
      return;
    }

    const texto = await resposta.text();
    throw new PlatformApiError(
      `Falha ao enviar o pedaço ${inicio}-${fim} para o TikTok (${resposta.status}): ${texto.slice(0, 300)}`,
      {
        retryable: resposta.status >= 500 || resposta.status === 408,
        platform: PLATFORM,
        httpStatus: resposta.status,
      },
    );
  } catch (erro) {
    if (erro instanceof PlatformApiError) throw erro;
    if (erro instanceof Error && (erro.name === 'AbortError' || erro.name === 'TimeoutError')) {
      throw new PlatformApiError(`Tempo esgotado ao enviar o pedaço ${inicio}-${fim} ao TikTok.`, {
        retryable: true,
        platform: PLATFORM,
      });
    }
    throw new PlatformApiError(
      `Falha de rede ao enviar o vídeo ao TikTok: ${erro instanceof Error ? erro.message : String(erro)}`,
      { retryable: true, platform: PLATFORM, cause: erro },
    );
  } finally {
    cancel();
  }
}

// ---------------------------------------------------------------------------
//  Foto — PULL_FROM_URL
// ---------------------------------------------------------------------------

async function publicarFotos(
  credentials: PlatformCredentials,
  input: PublishInput,
  postInfo: Record<string, unknown>,
  ctx: AdapterContext,
): Promise<PublishResult> {
  // O endpoint de foto do TikTok não aceita upload direto: ele BUSCA as
  // imagens numa URL. Sem a URL assinada não há como publicar, e inventar um
  // endereço só transformaria a falha num erro remoto obscuro.
  const urls = input.media.map((midia) => {
    if (!midia.publicUrl) {
      throw new PlatformApiError(
        'O TikTok busca as imagens por URL, e este destino não recebeu uma URL assinada ' +
          'de download. Verifique a configuração do storage.',
        { retryable: false, platform: PLATFORM },
      );
    }
    return midia.publicUrl;
  });

  const init = await tiktokRequest<InitResponse>({
    path: '/v2/post/publish/content/init/',
    accessToken: credentials.accessToken,
    body: {
      media_type: 'PHOTO',
      post_mode: 'DIRECT_POST',
      post_info: postInfo,
      source_info: {
        source: 'PULL_FROM_URL',
        photo_cover_index: 0,
        photo_images: urls,
      },
    },
    ctx,
  });

  const publishId = init.data?.publish_id;
  if (!publishId) {
    throw new PlatformApiError('O TikTok não devolveu publish_id para o post de fotos.', {
      retryable: true,
      platform: PLATFORM,
    });
  }

  return { remoteId: publishId, processingPending: true, raw: init.data };
}

// ---------------------------------------------------------------------------

async function consultarCreatorInfo(
  credentials: PlatformCredentials,
  ctx: AdapterContext,
): Promise<CreatorInfoResponse> {
  return tiktokRequest<CreatorInfoResponse>({
    path: '/v2/post/publish/creator_info/query/',
    accessToken: credentials.accessToken,
    ctx,
  });
}

export function interpretarStatus(remoteId: string, resposta: StatusResponse): RemotePostState {
  const dados = resposta.data ?? {};
  const status = dados.status;
  const postId = dados.publicaly_available_post_id?.[0];

  if (status === 'PUBLISH_COMPLETE') {
    return {
      remoteId,
      status: 'READY',
      // A URL só existe quando o TikTok devolve o id público do post. Montar
      // um endereço a partir do publish_id daria um link quebrado.
      ...(postId ? { remoteUrl: `https://www.tiktok.com/video/${postId}` } : {}),
    };
  }

  if (status === 'FAILED') {
    return {
      remoteId,
      status: 'REJECTED',
      rejectionReason: dados.fail_reason ?? 'O TikTok recusou a publicação sem informar o motivo.',
    };
  }

  // PROCESSING_UPLOAD, PROCESSING_DOWNLOAD, SEND_TO_USER_INBOX e afins.
  return { remoteId, status: 'PROCESSING' };
}

function rotuloDePrivacidade(valor: string): string {
  const rotulos: Record<string, string> = {
    PUBLIC_TO_EVERYONE: 'Público — qualquer pessoa',
    MUTUAL_FOLLOW_FRIENDS: 'Amigos — quem segue e é seguido',
    FOLLOWER_OF_CREATOR: 'Seguidores',
    SELF_ONLY: 'Somente você (privado)',
  };

  // Um valor novo da API ainda aparece para o usuário, com o próprio código
  // como rótulo — melhor do que sumir da lista.
  return rotulos[valor] ?? valor;
}
