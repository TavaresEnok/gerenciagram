import type { PlatformKey } from '../platform/capabilities.js';

/**
 * Contratos das filas — nomes e formato de payload.
 *
 * Ficam no núcleo (e não no worker) porque são a fronteira entre quem
 * enfileira e quem consome: API e worker são processos separados, com deploys
 * separados, e o payload é a única coisa que os dois precisam concordar.
 * Nada de BullMQ aqui: isto é contrato, não transporte.
 *
 * REGRA: nenhum payload carrega token, senha ou conteúdo de mídia. Só
 * identificadores — o worker recarrega o que precisa do banco. Payload de
 * job fica gravado no Redis e aparece no painel de filas (SPEC seção 19).
 */

export const QUEUE_NAMES = {
  publish: 'publish',
  mediaProcessing: 'media-processing',
  tokenRefresh: 'token-refresh',
  analyticsCollection: 'analytics-collection',
  inboxSync: 'inbox-sync',
  notifications: 'notifications',
  reports: 'reports',
  maintenance: 'maintenance',
  deadLetter: 'dead-letter',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Todo payload carrega o correlation ID que atravessa a requisição inteira. */
export interface BaseJobPayload {
  correlationId: string;
}

// ---------------------------------------------------------------------------
//  Publicação
// ---------------------------------------------------------------------------

export const JOB_PUBLISH_TARGET = 'publish-target';

/**
 * Um job POR DESTINO — nunca um job por post.
 *
 * É o que garante o requisito da SPEC seção 12: falha em 3 contas não afeta
 * as outras 17, e "tentar novamente" reprocessa só as que falharam.
 */
export interface PublishTargetPayload extends BaseJobPayload {
  postTargetId: string;
  organizationId: string;
  platform: PlatformKey;
  /**
   * Repetida aqui só para a deduplicação do BullMQ (`jobId`). A verdade
   * continua sendo a UNIQUE (postId, socialAccountId) no banco.
   */
  idempotencyKey: string;
  /** Tentativa manual disparada pelo usuário, não pelo agendamento. */
  manualRetry?: boolean;
}

export const JOB_CHECK_REMOTE_STATE = 'check-remote-state';

/** Confirma o estado de um vídeo que a plataforma processa de forma assíncrona. */
export interface CheckRemoteStatePayload extends BaseJobPayload {
  postTargetId: string;
  organizationId: string;
  attempt: number;
}

// ---------------------------------------------------------------------------
//  Mídia
// ---------------------------------------------------------------------------

export const JOB_PROCESS_MEDIA = 'process-media';

export interface ProcessMediaPayload extends BaseJobPayload {
  mediaAssetId: string;
  organizationId: string;
}

// ---------------------------------------------------------------------------
//  Tokens
// ---------------------------------------------------------------------------

export const JOB_REFRESH_TOKEN = 'refresh-token';

export interface RefreshTokenPayload extends BaseJobPayload {
  socialAccountId: string;
  organizationId: string;
}

export const JOB_SCAN_EXPIRING_TOKENS = 'scan-expiring-tokens';

// ---------------------------------------------------------------------------
//  Analytics e inbox
// ---------------------------------------------------------------------------

export const JOB_COLLECT_ACCOUNT_METRICS = 'collect-account-metrics';
export const JOB_COLLECT_POST_METRICS = 'collect-post-metrics';

export interface CollectMetricsPayload extends BaseJobPayload {
  socialAccountId: string;
  organizationId: string;
  /** Dia de referência em ISO (UTC). */
  forDate: string;
}

export const JOB_SYNC_INBOX = 'sync-inbox';

export interface SyncInboxPayload extends BaseJobPayload {
  socialAccountId: string;
  organizationId: string;
}

// ---------------------------------------------------------------------------
//  Notificações e relatórios
// ---------------------------------------------------------------------------

export const JOB_SEND_NOTIFICATION = 'send-notification';

export interface SendNotificationPayload extends BaseJobPayload {
  notificationId: string;
  organizationId: string;
}

export const JOB_GENERATE_REPORT = 'generate-report';

export interface GenerateReportPayload extends BaseJobPayload {
  reportId: string;
  organizationId: string;
}

// ---------------------------------------------------------------------------
//  Manutenção (retenção, expurgo, LGPD)
// ---------------------------------------------------------------------------

export const JOB_APPLY_RETENTION = 'apply-retention';
export const JOB_PROCESS_DATA_DELETION = 'process-data-deletion';

export interface ProcessDataDeletionPayload extends BaseJobPayload {
  deletionRequestId: string;
  organizationId: string;
}

// ---------------------------------------------------------------------------
//  Deduplicação de job
// ---------------------------------------------------------------------------

/**
 * `jobId` determinístico. Enfileirar o mesmo destino duas vezes (dupla
 * submissão, reprocessamento, corrida entre réplicas da API) resulta em UM
 * job, porque o BullMQ ignora um job cujo id já existe.
 */
export function publishJobId(postTargetId: string): string {
  return `publish:${postTargetId}`;
}

export function mediaJobId(mediaAssetId: string): string {
  return `media:${mediaAssetId}`;
}

export function tokenRefreshJobId(socialAccountId: string): string {
  return `token:${socialAccountId}`;
}

export function metricsJobId(socialAccountId: string, forDate: string): string {
  return `metrics:${socialAccountId}:${forDate}`;
}
