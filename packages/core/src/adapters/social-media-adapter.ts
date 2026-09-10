import type { PlatformDefinition, PlatformKey } from '../platform/capabilities.js';
import type {
  AccountMetrics,
  AdapterContext,
  AppCredentials,
  AuthorizationUrlParams,
  DynamicFieldOptions,
  MetricsWindow,
  OAuthCallbackParams,
  PlatformCredentials,
  PostMetrics,
  PublishInput,
  PublishResult,
  RemoteAccountIdentity,
  RemoteComment,
  RemotePostState,
  TokenExchangeResult,
} from './types.js';

/**
 * As abstrações centrais da SPEC seção 4.
 *
 * Separadas em três interfaces de propósito (`SocialAuthenticator`,
 * `SocialPublisher`, `SocialAnalytics`) porque nem toda rede suporta as três
 * coisas. `SocialMediaAdapter` é a composição que o núcleo consome.
 *
 * Um adapter NUNCA:
 *   - decide se pode publicar (isso é do validador, que lê as capacidades);
 *   - persiste nada (não conhece Prisma);
 *   - re-tenta sozinho (o retry é do worker, com backoff e circuit breaker);
 *   - simula uma operação que a plataforma não oferece — lança
 *     `UnsupportedByPlatformError`.
 */

export interface SocialAuthenticator {
  /** URL para onde o navegador do usuário é redirecionado. */
  buildAuthorizationUrl(app: AppCredentials, params: AuthorizationUrlParams): string;

  /** Troca o `code` do callback por tokens + identidade da conta. */
  exchangeCodeForTokens(
    app: AppCredentials,
    params: OAuthCallbackParams,
    ctx: AdapterContext,
  ): Promise<TokenExchangeResult>;

  /**
   * Renova o access token. Lança `TokenExpiredError` (não-recuperável) quando
   * o refresh token também morreu e o usuário precisa reconectar.
   */
  refreshCredentials(
    app: AppCredentials,
    credentials: PlatformCredentials,
    ctx: AdapterContext,
  ): Promise<PlatformCredentials>;

  /**
   * Revoga o token junto à plataforma. Obrigatório para o direito de exclusão
   * da LGPD (SPEC seção 11) — apagar a linha do banco não basta.
   */
  revoke(
    app: AppCredentials,
    credentials: PlatformCredentials,
    ctx: AdapterContext,
  ): Promise<void>;

  /** Relê a identidade da conta (nome/avatar mudam com o tempo). */
  fetchIdentity(
    credentials: PlatformCredentials,
    ctx: AdapterContext,
  ): Promise<RemoteAccountIdentity>;
}

export interface SocialPublisher {
  publish(
    credentials: PlatformCredentials,
    input: PublishInput,
    ctx: AdapterContext,
  ): Promise<PublishResult>;

  /** Consulta o estado remoto quando a plataforma processa de forma assíncrona. */
  fetchRemoteState(
    credentials: PlatformCredentials,
    remoteId: string,
    ctx: AdapterContext,
  ): Promise<RemotePostState>;

  deletePost(
    credentials: PlatformCredentials,
    remoteId: string,
    ctx: AdapterContext,
  ): Promise<void>;

  /**
   * Opções de campo obrigatório que dependem da conta/região e precisam vir
   * da API — nunca de uma lista fixa no código.
   */
  fetchDynamicFieldOptions(
    credentials: PlatformCredentials,
    ctx: AdapterContext,
  ): Promise<DynamicFieldOptions[]>;
}

export interface SocialAnalytics {
  fetchAccountMetrics(
    credentials: PlatformCredentials,
    window: MetricsWindow,
    ctx: AdapterContext,
  ): Promise<AccountMetrics>;

  fetchPostMetrics(
    credentials: PlatformCredentials,
    remoteIds: string[],
    ctx: AdapterContext,
  ): Promise<Map<string, PostMetrics>>;
}

export interface SocialInbox {
  fetchComments(
    credentials: PlatformCredentials,
    remotePostId: string,
    ctx: AdapterContext,
  ): Promise<RemoteComment[]>;

  replyToComment(
    credentials: PlatformCredentials,
    remoteCommentId: string,
    body: string,
    ctx: AdapterContext,
  ): Promise<{ remoteId: string }>;
}

/** Verificação de assinatura de webhook (SPEC seção 16). */
export interface SocialWebhookVerifier {
  verifySignature(rawBody: Buffer, headers: Record<string, string | undefined>): boolean;
  /** Desafio de verificação de subscrição, quando a plataforma usa um. */
  handleSubscriptionChallenge?(query: Record<string, string | undefined>): string | null;
}

/**
 * O adapter completo de uma rede. `analytics`, `inbox` e `webhooks` são
 * opcionais: a ausência significa que a rede não oferece aquilo por API
 * oficial, e o núcleo responde ao usuário com a mensagem da SPEC seção 3.
 */
export interface SocialMediaAdapter {
  readonly platform: PlatformKey;
  readonly definition: PlatformDefinition;

  readonly auth: SocialAuthenticator;
  readonly publisher: SocialPublisher;
  readonly analytics?: SocialAnalytics;
  readonly inbox?: SocialInbox;
  readonly webhooks?: SocialWebhookVerifier;
}

/** Resolve o adapter de uma plataforma. Implementado em @app/api e @app/worker. */
export interface AdapterRegistry {
  get(platform: PlatformKey): SocialMediaAdapter;
  has(platform: PlatformKey): boolean;
  list(): SocialMediaAdapter[];
}
