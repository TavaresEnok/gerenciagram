import type { Queue } from 'bullmq';
import type { WorkerContainer } from '../container.js';

/**
 * Alertas operacionais (SPEC seção 13).
 *
 * As métricas técnicas já existiam no painel admin, mas painel é PULL: só
 * avisa quem está olhando. Este job é o PUSH — roda sozinho, compara as
 * mesmas métricas com limiares configuráveis e avisa quem precisa agir.
 *
 * A avaliação é uma função PURA (`evaluateAlerts`), separada da coleta e do
 * envio de propósito: é nela que mora a decisão de disparar ou não, e é ela
 * que precisa ser provada sem banco, sem Redis e sem SMTP.
 *
 * Nenhum limiar é fixo no código. Todos vêm do ambiente, com padrão
 * documentado no `.env.example` — número mágico aqui viraria uma regra de
 * negócio escondida (SPEC seção 19).
 */

export interface AlertThresholds {
  /** Taxa de falha por plataforma, em % , a partir da qual alerta. */
  failureRatePercent: number;
  /**
   * Mínimo de publicações na janela para a taxa valer. Uma falha em uma
   * tentativa é 100% e não significa nada.
   */
  failureMinSample: number;
  deadLetterOpen: number;
  queueWaiting: number;
  accountsNeedingReconnect: number;
  /** Quanto tempo o mesmo alerta fica em silêncio depois de disparar. */
  cooldownMinutes: number;
}

export interface AlertSnapshot {
  circuits: Array<{ platform: string; state: string; failureCount: number }>;
  deadLetterOpen: number;
  queues: Array<{ name: string; waiting: number; active: number; failed: number }>;
  /** Por plataforma: falhas, sucessos e o total da janela. */
  publishOutcomes: Array<{ platform: string; failed: number; published: number }>;
  accountsNeedingReconnect: number;
}

export interface Alert {
  /** Identidade estável do alerta — é a chave do silêncio pós-disparo. */
  key: string;
  severity: 'WARNING' | 'CRITICAL';
  title: string;
  body: string;
}

// ---------------------------------------------------------------------------
//  Avaliação — pura, sem efeito colateral
// ---------------------------------------------------------------------------

export function evaluateAlerts(
  snapshot: AlertSnapshot,
  thresholds: AlertThresholds,
): Alert[] {
  const alertas: Alert[] = [];

  // --- Circuito aberto ---
  // Não tem limiar: circuito aberto já É a decisão de parar de chamar a
  // plataforma. Quem opera precisa saber no momento em que acontece.
  for (const circuito of snapshot.circuits) {
    if (circuito.state === 'OPEN') {
      alertas.push({
        key: `circuit:${circuito.platform}`,
        severity: 'CRITICAL',
        title: `Circuito aberto: ${circuito.platform}`,
        body:
          `A integração com ${circuito.platform} foi suspensa depois de ` +
          `${circuito.failureCount} falhas seguidas. Nenhuma publicação para essa rede ` +
          'está sendo tentada até o circuito voltar a fechar.',
      });
    }
  }

  // --- Taxa de falha por plataforma ---
  for (const resultado of snapshot.publishOutcomes) {
    const total = resultado.failed + resultado.published;
    if (total < thresholds.failureMinSample) continue;

    const taxa = Math.round((resultado.failed / total) * 1000) / 10;
    if (taxa < thresholds.failureRatePercent) continue;

    alertas.push({
      key: `failure-rate:${resultado.platform}`,
      severity: 'CRITICAL',
      title: `Taxa de falha alta em ${resultado.platform}: ${taxa}%`,
      body:
        `${resultado.failed} de ${total} publicações falharam em ${resultado.platform} ` +
        `na janela avaliada (limiar: ${thresholds.failureRatePercent}%).`,
    });
  }

  // --- Dead-letter acumulando ---
  if (snapshot.deadLetterOpen >= thresholds.deadLetterOpen) {
    alertas.push({
      key: 'dead-letter',
      severity: 'CRITICAL',
      title: `${snapshot.deadLetterOpen} jobs na dead-letter sem resolução`,
      body:
        `Há ${snapshot.deadLetterOpen} jobs que esgotaram as tentativas e ninguém tratou ` +
        `(limiar: ${thresholds.deadLetterOpen}). Cada um é uma publicação que não saiu.`,
    });
  }

  // --- Fila crescendo ---
  for (const fila of snapshot.queues) {
    if (fila.waiting < thresholds.queueWaiting) continue;

    alertas.push({
      key: `queue:${fila.name}`,
      severity: 'WARNING',
      title: `Fila "${fila.name}" com ${fila.waiting} jobs esperando`,
      body:
        `A fila "${fila.name}" acumulou ${fila.waiting} jobs em espera com ${fila.active} ` +
        `em execução (limiar: ${thresholds.queueWaiting}). Publicação agendada pode ` +
        'atrasar em relação ao horário escolhido.',
    });
  }

  // --- Contas pedindo reconexão ---
  if (snapshot.accountsNeedingReconnect >= thresholds.accountsNeedingReconnect) {
    alertas.push({
      key: 'accounts-needing-reconnect',
      severity: 'WARNING',
      title: `${snapshot.accountsNeedingReconnect} contas precisam ser reconectadas`,
      body:
        `${snapshot.accountsNeedingReconnect} contas estão com o token revogado ou ` +
        `expirado (limiar: ${thresholds.accountsNeedingReconnect}). Elas não publicam ` +
        'até alguém reconectar.',
    });
  }

  // Mais grave primeiro: quem lê o e-mail vê o que importa antes.
  return alertas.sort((a, b) =>
    a.severity === b.severity ? a.key.localeCompare(b.key) : a.severity === 'CRITICAL' ? -1 : 1,
  );
}

// ---------------------------------------------------------------------------
//  Coleta e despacho
// ---------------------------------------------------------------------------

/** Guarda quais alertas já dispararam, para não repetir a cada rodada. */
export interface AlertCooldownStore {
  /** true = pode disparar agora (e o silêncio começa); false = ainda em silêncio. */
  shouldFire(key: string, cooldownMinutes: number): Promise<boolean>;
}

/**
 * Silêncio guardado no Redis, com TTL.
 *
 * `SET key ... NX EX` é atômico: com duas réplicas do worker avaliando ao
 * mesmo tempo, só uma manda o e-mail. Fazer isso em memória mandaria um
 * e-mail por réplica.
 */
export function createRedisCooldownStore(
  container: WorkerContainer,
): AlertCooldownStore {
  return {
    async shouldFire(key: string, cooldownMinutes: number): Promise<boolean> {
      const resultado = await container.redis.set(
        `${container.env.QUEUE_PREFIX}:alert:${key}`,
        Date.now().toString(),
        'EX',
        Math.max(60, cooldownMinutes * 60),
        'NX',
      );

      return resultado === 'OK';
    },
  };
}

export function loadAlertThresholds(container: WorkerContainer): AlertThresholds {
  const env = container.env;

  return {
    failureRatePercent: env.ALERT_FAILURE_RATE_PERCENT,
    failureMinSample: env.ALERT_FAILURE_MIN_SAMPLE,
    deadLetterOpen: env.ALERT_DEAD_LETTER_OPEN,
    queueWaiting: env.ALERT_QUEUE_WAITING,
    accountsNeedingReconnect: env.ALERT_ACCOUNTS_NEEDING_RECONNECT,
    cooldownMinutes: env.ALERT_COOLDOWN_MINUTES,
  };
}

/** Janela de publicações considerada na taxa de falha. */
const JANELA_HORAS = 24;

export async function collectAlertSnapshot(
  container: WorkerContainer,
  queues: Queue[],
): Promise<AlertSnapshot> {
  const desde = new Date(Date.now() - JANELA_HORAS * 60 * 60_000);

  const [circuitos, deadLetterOpen, falhas, publicados, precisamReconectar] = await Promise.all([
    container.prisma.socialPlatform.findMany({
      select: { key: true, circuitState: true, circuitFailureCount: true },
    }),
    container.prisma.deadLetterJob.count({ where: { resolvedAt: null } }),
    container.prisma.postTarget.groupBy({
      by: ['platform'],
      where: { status: 'FAILED', updatedAt: { gte: desde } },
      _count: { _all: true },
    }),
    container.prisma.postTarget.groupBy({
      by: ['platform'],
      where: { status: 'PUBLISHED', publishedAt: { gte: desde } },
      _count: { _all: true },
    }),
    container.prisma.socialAccount.count({
      where: { status: 'NEEDS_RECONNECT', deletedAt: null },
    }),
  ]);

  const plataformas = new Set([
    ...falhas.map((linha) => linha.platform as string),
    ...publicados.map((linha) => linha.platform as string),
  ]);

  const contagens = await Promise.all(
    queues.map(async (fila) => {
      const counts = await fila.getJobCounts('waiting', 'active', 'failed');
      return {
        name: fila.name,
        waiting: counts['waiting'] ?? 0,
        active: counts['active'] ?? 0,
        failed: counts['failed'] ?? 0,
      };
    }),
  );

  return {
    circuits: circuitos.map((circuito) => ({
      platform: circuito.key,
      state: circuito.circuitState,
      failureCount: circuito.circuitFailureCount,
    })),
    deadLetterOpen,
    queues: contagens,
    publishOutcomes: [...plataformas].map((platform) => ({
      platform,
      failed: falhas.find((linha) => linha.platform === platform)?._count._all ?? 0,
      published: publicados.find((linha) => linha.platform === platform)?._count._all ?? 0,
    })),
    accountsNeedingReconnect: precisamReconectar,
  };
}

/**
 * Avalia e despacha. Chamado pelo job periódico.
 *
 * Todo alerta que passa do silêncio vai para o LOG em nível de erro, sempre —
 * é o que qualquer coletor de log (Sentry, Loki, CloudWatch) consegue captar
 * sem acoplar o worker a um fornecedor. O e-mail é o canal adicional, e só
 * existe se `ALERT_EMAIL` estiver preenchido: sem destinatário configurado o
 * sistema não inventa um.
 */
export async function processEvaluateAlerts(
  container: WorkerContainer,
  queues: Queue[],
  cooldown: AlertCooldownStore,
): Promise<Alert[]> {
  const thresholds = loadAlertThresholds(container);
  const snapshot = await collectAlertSnapshot(container, queues);
  const alertas = evaluateAlerts(snapshot, thresholds);

  const disparados: Alert[] = [];

  for (const alerta of alertas) {
    if (!(await cooldown.shouldFire(alerta.key, thresholds.cooldownMinutes))) continue;
    disparados.push(alerta);

    container.logger.error(
      { alerta: alerta.key, severidade: alerta.severity, titulo: alerta.title },
      alerta.body,
    );
  }

  const destinatario = container.env.ALERT_EMAIL;
  if (disparados.length === 0 || !destinatario) return disparados;

  const corpo = disparados
    .map((alerta) => `[${alerta.severity}] ${alerta.title}\n${alerta.body}`)
    .join('\n\n');

  try {
    await container.mailer.send({
      to: destinatario,
      subject:
        disparados.length === 1
          ? `[Alerta] ${disparados[0]?.title}`
          : `[Alerta] ${disparados.length} problemas operacionais`,
      text: `${corpo}\n\n${container.env.WEB_PUBLIC_URL.replace(/\/$/, '')}/admin`,
    });
  } catch (erro) {
    // Falhar o e-mail não pode derrubar o job: o alerta já está no log, que é
    // o canal que não depende de SMTP.
    container.logger.error({ err: erro }, 'não foi possível enviar o e-mail de alerta');
  }

  return disparados;
}
