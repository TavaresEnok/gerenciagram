/**
 * Tipos de fronteira entre o núcleo e os adapters de plataforma.
 *
 * O núcleo NUNCA importa nada de uma implementação concreta (SPEC seção 4).
 * Tudo que ele sabe sobre "publicar no YouTube" está descrito aqui.
 */

// ---------------------------------------------------------------------------
//  Credenciais e contexto
// ---------------------------------------------------------------------------

/**
 * Tokens já DECIFRADOS, entregues ao adapter no momento da chamada.
 *
 * Vivem em memória apenas durante a operação. Nunca são serializados em log,
 * nunca vão para o payload de um job e nunca chegam ao frontend
 * (SPEC seções 6, 10 e 19).
 */
export interface PlatformCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes: string[];
}

/** Credenciais do APLICATIVO (client id/secret), não do usuário. */
export interface AppCredentials {
  clientId: string;
  clientSecret: string;
  /** URI de callback registrada no console da plataforma. */
  redirectUri: string;
}

export interface AdapterContext {
  /** Atravessa API -> fila -> worker -> chamada externa (SPEC seção 13). */
  correlationId: string;
  /** Timeout obrigatório. Nenhuma chamada externa espera indefinidamente. */
  timeoutMs: number;
  /** Cancelamento cooperativo (shutdown do worker, cancelamento pelo usuário). */
  signal?: AbortSignal;
  logger: AdapterLogger;
}

export interface AdapterLogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
//  OAuth
// ---------------------------------------------------------------------------

export interface AuthorizationUrlParams {
  /** Valor anti-CSRF, validado no callback. */
  state: string;
  scopes: string[];
  /** PKCE, quando a plataforma suporta. */
  codeChallenge?: string;
}

export interface OAuthCallbackParams {
  code: string;
  codeVerifier?: string;
}

/** Identidade da conta na plataforma, lida logo após o OAuth. */
export interface RemoteAccountIdentity {
  remoteId: string;
  username?: string;
  displayName?: string;
  avatarUrl?: string;
  profileUrl?: string;
  isBusinessAccount?: boolean;
  /** Dados específicos da rede que o adapter precisa guardar. */
  metadata?: Record<string, unknown>;
}

export interface TokenExchangeResult {
  credentials: PlatformCredentials;
  identity: RemoteAccountIdentity;
}

// ---------------------------------------------------------------------------
//  Publicação
// ---------------------------------------------------------------------------

export interface PublishMediaInput {
  /**
   * Stream do arquivo vindo do storage, para as plataformas que RECEBEM os
   * bytes (YouTube, TikTok).
   */
  stream: () => NodeJS.ReadableStream;

  /**
   * URL temporária e assinada de onde a plataforma pode BUSCAR a mídia.
   *
   * A Meta não aceita upload direto na publicação: ela exige que o arquivo
   * esteja numa URL pública que os servidores dela consigam alcançar. Os dois
   * modelos coexistem no contrato porque são exigências reais de plataformas
   * diferentes — um adapter que precise deste campo e não o receba deve
   * falhar de forma explícita, nunca inventar uma URL.
   *
   * A URL precisa continuar válida durante todo o processamento remoto: a
   * Meta leva até alguns minutos para buscar e transcodificar um vídeo.
   */
  publicUrl?: string;
  mimeType: string;
  sizeBytes: number;
  filename: string;
  durationMs?: number;
  width?: number;
  height?: number;
}

export interface PublishInput {
  /**
   * Chave de idempotência do destino, derivada de (postId, socialAccountId).
   * Enviada à plataforma quando ela suporta; sempre usada internamente para
   * garantir que reprocessar um job não publique duas vezes.
   */
  idempotencyKey: string;

  title?: string;
  body: string;
  hashtags: string[];

  media: PublishMediaInput[];

  /**
   * Campos obrigatórios da plataforma coletados no compositor
   * (privacyStatus, categoryId, consentimento do TikTok...).
   * Validados contra `requiredUxFields` antes de chegar aqui.
   */
  platformFields: Record<string, unknown>;

  /**
   * Agendamento nativo da plataforma, quando suportado. Nulo = publicar agora.
   * O agendamento normal do sistema é feito pela nossa fila, não por aqui.
   */
  publishAt?: Date;
}

export interface PublishResult {
  remoteId: string;
  remoteUrl?: string;
  /**
   * Quando a plataforma aceita o envio mas ainda processa de forma assíncrona
   * (transcodificação de vídeo), o destino fica publicado mas com estado
   * remoto pendente — a confirmação vem depois.
   */
  processingPending?: boolean;
  raw?: unknown;
}

/**
 * Resultado de uma verificação de estado remoto pós-publicação, para os casos
 * em que a plataforma processa o vídeo de forma assíncrona.
 */
export interface RemotePostState {
  remoteId: string;
  status: 'PROCESSING' | 'READY' | 'REJECTED' | 'DELETED';
  rejectionReason?: string;
  remoteUrl?: string;
}

// ---------------------------------------------------------------------------
//  Métricas
// ---------------------------------------------------------------------------

export interface AccountMetrics {
  followers?: number;
  impressions?: number;
  reach?: number;
  views?: number;
  raw?: Record<string, unknown>;
}

export interface PostMetrics {
  impressions?: number;
  reach?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  views?: number;
  watchTimeSeconds?: number;
  clicks?: number;
  raw?: Record<string, unknown>;
}

export interface MetricsWindow {
  since: Date;
  until: Date;
}

// ---------------------------------------------------------------------------
//  Inbox
// ---------------------------------------------------------------------------

export interface RemoteComment {
  remoteId: string;
  remoteParentId?: string;
  remotePostId?: string;
  authorRemoteId?: string;
  authorUsername?: string;
  authorAvatarUrl?: string;
  body: string;
  postedAt: Date;
  raw?: unknown;
}

// ---------------------------------------------------------------------------
//  Opções dinâmicas de campos de UX
// ---------------------------------------------------------------------------

/**
 * Algumas opções de campo obrigatório dependem da conta e precisam vir da API
 * no momento da composição (ex.: níveis de privacidade que o TikTok libera
 * para aquele perfil, categorias de vídeo do YouTube para aquela região).
 * Hardcodear essas listas seria inventar comportamento de API (SPEC seção 19).
 */
export interface DynamicFieldOptions {
  fieldKey: string;
  options: Array<{ value: string; label: string }>;
}

// PlatformKey e RequiredUxField são exportados por platform/capabilities.ts —
// re-exportá-los aqui criaria conflito de nome no index do pacote.
