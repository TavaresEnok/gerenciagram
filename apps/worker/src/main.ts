import {
  JOB_APPLY_RETENTION,
  JOB_COLLECT_ACCOUNT_METRICS,
  JOB_PROCESS_DATA_DELETION,
  JOB_GENERATE_REPORT,
  JOB_PROCESS_MEDIA,
  JOB_PUBLISH_TARGET,
  JOB_REFRESH_TOKEN,
  JOB_SCAN_EXPIRING_TOKENS,
  JOB_SYNC_INBOX,
  QUEUE_NAMES,
  type RefreshTokenPayload,
  type SyncInboxPayload,
} from '@app/core';
import { Queue, Worker, type Job } from 'bullmq';
import { closeWorkerContainer, createWorkerContainer, type WorkerContainer } from './container.js';
import { recordDeadLetter } from './lib/dead-letter.js';
import { createRedisCooldownStore, processEvaluateAlerts } from './processors/alerts.js';
import { processCollectMetrics } from './processors/analytics.js';
import { processSyncInbox, scanAccountsForInboxSync } from './processors/inbox.js';
import { applyRetention, processDataDeletion, reconcileOrphanTargets } from './processors/maintenance.js';
import { processMedia } from './processors/media.js';
import { processPublishTarget } from './processors/publish.js';
import { processGenerateReport } from './processors/reports.js';
import { processTokenRefresh, scanExpiringTokens } from './processors/tokens.js';

const JOB_RECONCILE_ORPHANS = 'maintenance:reconcile-orphans';

/**
 * Dispara uma rodada de sincronização da inbox: este job não busca nada, só
 * enfileira um `sync-inbox` por conta ativa. Separar o agendador do trabalho
 * é o que mantém cada conta como unidade independente de falha e de retry.
 */
const JOB_SCAN_INBOX = 'inbox:scan-accounts';

/**
 * Avalia as métricas técnicas contra os limiares e dispara os alertas. O
 * painel admin é PULL — só avisa quem está olhando; este job é o PUSH.
 */
const JOB_EVALUATE_ALERTS = 'maintenance:evaluate-alerts';

/**
 * Processo de workers.
 *
 * Separado da API porque as duas cargas são incompatíveis: a API precisa
 * responder em 300ms (SPEC seção 2) e o worker passa minutos enviando vídeo.
 * Num processo só, um upload grande seguraria o event loop e derrubaria o p95
 * de todo mundo.
 *
 * Filas separadas por tipo, com concorrência própria: a fila de publicação
 * não pode ficar atrás de uma fila de processamento de vídeo.
 */

async function main(): Promise<void> {
  const container = createWorkerContainer();
  const { env, logger } = container;

  const workers: Worker[] = [];
  const queues: Queue[] = [];

  const makeWorker = <T>(
    name: string,
    handler: (job: Job<T>) => Promise<void>,
    concurrency: number,
  ): Worker => {
    const worker = new Worker<T>(name, handler, {
      connection: { url: env.REDIS_URL, maxRetriesPerRequest: null },
      prefix: env.QUEUE_PREFIX,
      concurrency,
      // Sem isto, um job que trava mantém o lock e nenhum outro worker o
      // reprocessa. 5 minutos cobre um upload longo com folga.
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    });

    worker.on('failed', (job, error) => {
      logger.error(
        {
          queue: name,
          jobId: job?.id,
          tentativas: job?.attemptsMade,
          correlationId: (job?.data as { correlationId?: string } | undefined)?.correlationId,
          err: error,
        },
        'job falhou',
      );

      // Esgotou as tentativas do BullMQ: registra na dead-letter para o
      // painel admin. O processador de publicação já faz isso por conta
      // própria; aqui cobrimos as demais filas.
      if (job && name !== QUEUE_NAMES.publish && job.attemptsMade >= (job.opts.attempts ?? 1)) {
        void recordDeadLetter(container, {
          queueName: name,
          jobName: job.name,
          jobId: job.id ?? null,
          organizationId:
            (job.data as { organizationId?: string } | undefined)?.organizationId ?? null,
          payload: job.data as Record<string, unknown>,
          attemptsMade: job.attemptsMade,
          failedReason: error.message,
          stackTrace: error.stack ?? '',
          correlationId: (job.data as { correlationId?: string } | undefined)?.correlationId ?? '',
        });
      }
    });

    worker.on('stalled', (jobId) => {
      logger.warn({ queue: name, jobId }, 'job travado — será reprocessado');
    });

    worker.on('error', (error) => {
      logger.error({ queue: name, err: error }, 'erro no worker');
    });

    workers.push(worker);
    return worker;
  };

  // --- Publicação ----------------------------------------------------------
  const publishQueue = new Queue(QUEUE_NAMES.publish, {
    connection: { url: env.REDIS_URL, maxRetriesPerRequest: null },
    prefix: env.QUEUE_PREFIX,
  });
  queues.push(publishQueue);

  makeWorker(
    QUEUE_NAMES.publish,
    (job) => processPublishTarget(container, job as never),
    env.PUBLISH_CONCURRENCY,
  );

  // --- Mídia ---------------------------------------------------------------
  makeWorker(
    QUEUE_NAMES.mediaProcessing,
    (job) => processMedia(container, job as never),
    env.MEDIA_CONCURRENCY,
  );

  // --- Tokens --------------------------------------------------------------
  const tokenQueue = new Queue(QUEUE_NAMES.tokenRefresh, {
    connection: { url: env.REDIS_URL, maxRetriesPerRequest: null },
    prefix: env.QUEUE_PREFIX,
  });
  queues.push(tokenQueue);

  makeWorker(
    QUEUE_NAMES.tokenRefresh,
    async (job: Job) => {
      if (job.name === JOB_SCAN_EXPIRING_TOKENS) {
        await scanExpiringTokens(container, async (payload: RefreshTokenPayload) => {
          await tokenQueue.add(JOB_REFRESH_TOKEN, payload, {
            jobId: `token:${payload.socialAccountId}`,
            attempts: 3,
            backoff: { type: 'exponential', delay: 60_000 },
          });
        });
        return;
      }
      await processTokenRefresh(container, job as never);
    },
    3,
  );

  // --- Analytics -----------------------------------------------------------
  makeWorker(
    QUEUE_NAMES.analyticsCollection,
    (job) => processCollectMetrics(container, job as never),
    3,
  );

  // --- Inbox ---------------------------------------------------------------
  const inboxQueue = new Queue(QUEUE_NAMES.inboxSync, {
    connection: { url: env.REDIS_URL, maxRetriesPerRequest: null },
    prefix: env.QUEUE_PREFIX,
  });
  queues.push(inboxQueue);

  makeWorker(
    QUEUE_NAMES.inboxSync,
    async (job: Job) => {
      if (job.name === JOB_SCAN_INBOX) {
        const contas = await scanAccountsForInboxSync(
          container,
          async (payload: SyncInboxPayload, jobId: string) => {
            await inboxQueue.add(JOB_SYNC_INBOX, payload, {
              jobId,
              attempts: 3,
              backoff: { type: 'exponential', delay: 60_000 },
              // Sem a remoção, o `jobId` fixo da rodada anterior ainda existe
              // na fila e a próxima seria descartada como duplicada.
              removeOnComplete: true,
              removeOnFail: true,
            });
          },
        );
        logger.debug({ contas }, 'rodada de sincronização da inbox enfileirada');
        return;
      }

      await processSyncInbox(container, job as never);
    },
    3,
  );

  // --- Relatórios ----------------------------------------------------------
  makeWorker(
    QUEUE_NAMES.reports,
    (job) => processGenerateReport(container, job as never),
    2,
  );

  // --- Manutenção ----------------------------------------------------------
  makeWorker(
    QUEUE_NAMES.maintenance,
    async (job: Job) => {
      if (job.name === JOB_APPLY_RETENTION) {
        await applyRetention(container);
        return;
      }
      if (job.name === JOB_PROCESS_DATA_DELETION) {
        await processDataDeletion(container, job as never);
        return;
      }
      if (job.name === JOB_RECONCILE_ORPHANS) {
        await reconcileOrphanTargets(container, publishQueue);
        return;
      }
      if (job.name === JOB_EVALUATE_ALERTS) {
        // `queues` são as mesmas instâncias que o worker usa: a profundidade
        // medida é a real, não uma reconstrução.
        await processEvaluateAlerts(container, queues, createRedisCooldownStore(container));
        return;
      }
      logger.warn({ jobName: job.name }, 'job de manutenção desconhecido');
    },
    1,
  );

  // --- Jobs repetíveis -----------------------------------------------------
  const maintenanceQueue = new Queue(QUEUE_NAMES.maintenance, {
    connection: { url: env.REDIS_URL, maxRetriesPerRequest: null },
    prefix: env.QUEUE_PREFIX,
  });
  queues.push(maintenanceQueue);

  await tokenQueue.add(
    JOB_SCAN_EXPIRING_TOKENS,
    { correlationId: 'token-scan' },
    {
      // A cada 30 min. O `jobId` fixo impede que subir uma segunda réplica do
      // worker registre um segundo agendador para o mesmo trabalho.
      repeat: { pattern: '*/30 * * * *' },
      jobId: 'repeat:scan-expiring-tokens',
      removeOnComplete: true,
    },
  );

  await maintenanceQueue.add(
    JOB_APPLY_RETENTION,
    { correlationId: 'retention' },
    {
      // 3h da manhã, quando o volume de publicação é menor.
      repeat: { pattern: '0 3 * * *' },
      jobId: 'repeat:apply-retention',
      removeOnComplete: true,
    },
  );

  await inboxQueue.add(
    JOB_SCAN_INBOX,
    { correlationId: 'inbox-scan' },
    {
      // A cada 15 min. Comentário novo aparece na inbox em minutos, e o
      // intervalo mantém o consumo de cota previsível: uma varredura por
      // conta a cada quarto de hora.
      repeat: { pattern: '*/15 * * * *' },
      jobId: 'repeat:scan-inbox',
      removeOnComplete: true,
    },
  );

  await maintenanceQueue.add(
    JOB_EVALUATE_ALERTS,
    { correlationId: 'evaluate-alerts' },
    {
      // A cada 5 min. O silêncio pós-disparo (ALERT_COOLDOWN_MINUTES) é o que
      // impede que um problema persistente vire um e-mail a cada rodada.
      repeat: { pattern: '*/5 * * * *' },
      jobId: 'repeat:evaluate-alerts',
      removeOnComplete: true,
    },
  );

  await maintenanceQueue.add(
    JOB_RECONCILE_ORPHANS,
    { correlationId: 'reconcile-orphans' },
    {
      // A cada 2 minutos verifica se algum destino SCHEDULED ou QUEUED ficou órfão.
      repeat: { pattern: '*/2 * * * *' },
      jobId: 'repeat:reconcile-orphans',
      removeOnComplete: true,
    },
  );

  // --- Shutdown gracioso ---------------------------------------------------
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'encerrando os workers...');

    const timer = setTimeout(() => {
      logger.error('shutdown demorou demais; encerrando à força');
      process.exit(1);
    }, 60_000);
    timer.unref();

    try {
      // `close()` espera os jobs em voo terminarem. É o que evita matar o
      // processo entre "publicou no YouTube" e "gravou o remoteId" — que
      // produziria a publicação duplicada que a SPEC seção 19 proíbe.
      await Promise.all(workers.map((worker) => worker.close()));
      await Promise.all(queues.map((queue) => queue.close()));
      await closeWorkerContainer(container);

      logger.info('workers encerrados com segurança');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'falha no shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'promise rejeitada sem tratamento');
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'exceção não capturada — encerrando');
    process.exit(1);
  });

  const configured = [...container.platforms.configuredPlatforms];

  logger.info(
    {
      filas: workers.length,
      concorrenciaPublicacao: env.PUBLISH_CONCURRENCY,
      plataformasConfiguradas: configured.length > 0 ? configured : 'nenhuma',
    },
    'workers no ar',
  );

  if (configured.length === 0) {
    logger.warn(
      'Nenhuma plataforma tem credenciais configuradas. Jobs de publicação vão ' +
        'falhar com PLATFORM_NOT_CONFIGURED até que o .env seja preenchido ' +
        '(ver SOCIAL_INTEGRATIONS.md).',
    );
  }
}

main().catch((error: unknown) => {
  console.error('Falha ao iniciar os workers:', error);
  process.exit(1);
});

export type { WorkerContainer };
export { JOB_PUBLISH_TARGET, JOB_PROCESS_MEDIA, JOB_COLLECT_ACCOUNT_METRICS };
