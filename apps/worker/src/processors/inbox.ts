import {
  UnsupportedByPlatformError,
  type RemoteComment,
  type SyncInboxPayload,
} from '@app/core';
import { getValidCredentials } from '@app/platform';
import type { Job } from 'bullmq';
import type { WorkerContainer } from '../container.js';
import { adapterContext } from '../lib/adapter-context.js';

/**
 * Sincronização da inbox (SPEC seção 6, módulo de Interações).
 *
 * A API de comentários das redes é POR PUBLICAÇÃO, não por conta: não existe
 * "me dê tudo que é novo nesta conta". Por isso o job varre os destinos
 * publicados recentemente e busca os comentários de cada um.
 *
 * Duas decisões que evitam problema:
 *
 *  - **Janela curta e teto de posts.** Comentário antigo praticamente não
 *    aparece, e cada post custa uma chamada. Varrer o histórico inteiro a
 *    cada rodada queimaria a cota da plataforma sem trazer nada novo.
 *  - **Falha num post não derruba a conta inteira.** Um vídeo apagado na
 *    origem devolve erro; se ele abortasse a rodada, os comentários dos
 *    outros posts nunca chegariam. É o mesmo princípio do fan-out de
 *    publicação: cada unidade falha sozinha.
 */

/** Quanto tempo depois de publicado um post ainda é varrido. */
const JANELA_DIAS = 14;

/** Teto de publicações por rodada, para não estourar a cota da plataforma. */
const MAX_POSTS_POR_RODADA = 50;

export async function processSyncInbox(
  container: WorkerContainer,
  job: Job<SyncInboxPayload>,
): Promise<void> {
  const { socialAccountId, correlationId } = job.data;
  const log = container.logger.child({ correlationId, socialAccountId });

  const account = await container.prisma.socialAccount.findUnique({
    where: { id: socialAccountId },
    select: {
      id: true,
      organizationId: true,
      platform: true,
      nickname: true,
      status: true,
      deletedAt: true,
    },
  });

  if (!account || account.deletedAt || account.status !== 'ACTIVE') {
    log.debug('conta indisponível — sincronização ignorada');
    return;
  }

  const adapter = container.platforms.adapters.get(account.platform);
  if (!adapter.inbox) {
    // A rede não expõe comentários por API oficial. Sair em silêncio é o
    // certo: a UI já mostra a capacidade como indisponível, e inventar uma
    // leitura por scraping é justamente o que a SPEC seção 19 proíbe.
    log.debug({ platform: account.platform }, 'plataforma sem API oficial de comentários');
    return;
  }

  const targets = await container.prisma.postTarget.findMany({
    where: {
      socialAccountId,
      status: 'PUBLISHED',
      remoteId: { not: null },
      publishedAt: { gte: new Date(Date.now() - JANELA_DIAS * 24 * 60 * 60_000) },
      deletedAt: null,
    },
    select: { id: true, remoteId: true },
    orderBy: { publishedAt: 'desc' },
    take: MAX_POSTS_POR_RODADA,
  });

  if (targets.length === 0) {
    log.debug('nenhuma publicação recente para sincronizar');
    return;
  }

  await container.circuit.assertClosed(account.platform);

  const ctx = adapterContext(container, correlationId, 30_000);
  const { credentials } = await getValidCredentials(
    { prisma: container.prisma, keyring: container.keyring, platforms: container.platforms },
    socialAccountId,
    ctx,
  );

  let novos = 0;
  let falhas = 0;

  for (const target of targets) {
    if (!target.remoteId) continue;

    let comentarios: RemoteComment[];
    try {
      comentarios = await adapter.inbox.fetchComments(credentials, target.remoteId, ctx);
    } catch (erro) {
      if (erro instanceof UnsupportedByPlatformError) {
        log.debug({ platform: account.platform }, 'leitura de comentários não suportada');
        return;
      }

      // Um post que falhou não impede os outros. O circuito só abre se a
      // plataforma inteira estiver ruim, o que a contagem abaixo decide.
      falhas += 1;
      log.warn(
        { postTargetId: target.id, err: erro },
        'falha ao buscar comentários desta publicação',
      );
      continue;
    }

    novos += await gravarComentarios(container, {
      organizationId: account.organizationId,
      socialAccountId,
      platform: account.platform,
      comentarios,
    });
  }

  // Todas as publicações falharam: o problema é da plataforma, não de um post
  // específico. Aí sim o circuito precisa saber.
  if (falhas === targets.length) {
    await container.circuit.onFailure(account.platform);
    throw new Error(
      `Falha ao sincronizar a inbox de ${account.nickname}: nenhuma das ` +
        `${targets.length} publicações respondeu.`,
    );
  }

  await container.circuit.onSuccess(account.platform);

  log.info(
    { platform: account.platform, publicacoes: targets.length, novos, falhas },
    'inbox sincronizada',
  );
}

/**
 * Grava os comentários novos.
 *
 * O `@@unique(socialAccountId, remoteId)` é o que torna a rodada idempotente:
 * rodar o job duas vezes não duplica nada. O `update` deliberadamente NÃO
 * toca em `isRead`, `isReplied` nem `replyBody` — reescrevê-los faria uma
 * ressincronização marcar como não lido um comentário que a equipe já tratou.
 */
async function gravarComentarios(
  container: WorkerContainer,
  params: {
    organizationId: string;
    socialAccountId: string;
    platform: string;
    comentarios: RemoteComment[];
  },
): Promise<number> {
  if (params.comentarios.length === 0) return 0;

  const antes = await container.prisma.comment.count({
    where: {
      socialAccountId: params.socialAccountId,
      remoteId: { in: params.comentarios.map((comentario) => comentario.remoteId) },
    },
  });

  /**
   * `upsert` numa operação só, e não `findUnique` seguido de `create`.
   *
   * Ler e depois escrever deixava uma janela: duas rodadas concorrentes da
   * mesma conta encontravam "não existe" e as duas tentavam inserir — a
   * segunda batia na UNIQUE e derrubava o job com exceção não tratada. O
   * `upsert` resolve no banco, que é quem tem a informação.
   *
   * O `update` toca SÓ no corpo: `isRead`, `isReplied` e `replyBody` são
   * estado nosso, não da plataforma. Reescrevê-los faria a ressincronização
   * devolver para a fila todo comentário que a equipe já tratou.
   */
  for (const comentario of params.comentarios) {
    await container.prisma.comment.upsert({
      where: {
        socialAccountId_remoteId: {
          socialAccountId: params.socialAccountId,
          remoteId: comentario.remoteId,
        },
      },
      update: {
        body: comentario.body,
        ...(comentario.raw !== undefined ? { raw: comentario.raw as object } : {}),
      },
      create: {
        organizationId: params.organizationId,
        socialAccountId: params.socialAccountId,
        platform: params.platform as never,
        remoteId: comentario.remoteId,
        remoteParentId: comentario.remoteParentId ?? null,
        remotePostId: comentario.remotePostId ?? null,
        authorRemoteId: comentario.authorRemoteId ?? null,
        authorUsername: comentario.authorUsername ?? null,
        authorAvatarUrl: comentario.authorAvatarUrl ?? null,
        body: comentario.body,
        postedAt: comentario.postedAt,
        ...(comentario.raw !== undefined ? { raw: comentario.raw as object } : {}),
      },
    });
  }

  return params.comentarios.length - antes;
}

/**
 * Enfileira uma rodada de sincronização para cada conta ativa de plataforma
 * que ofereça inbox.
 *
 * O `jobId` determinístico por conta impede que duas réplicas do worker (ou
 * duas execuções do agendador que se sobrepõem) sincronizem a mesma conta em
 * paralelo — o que dobraria o consumo de cota sem trazer nada novo.
 */
export async function scanAccountsForInboxSync(
  container: WorkerContainer,
  enqueue: (payload: SyncInboxPayload, jobId: string) => Promise<void>,
): Promise<number> {
  const plataformasComInbox = container.platforms.adapters
    .list()
    .filter((adapter) => adapter.inbox !== undefined)
    .map((adapter) => adapter.platform);

  if (plataformasComInbox.length === 0) return 0;

  const contas = await container.prisma.socialAccount.findMany({
    where: {
      status: 'ACTIVE',
      deletedAt: null,
      platform: { in: plataformasComInbox },
    },
    select: { id: true, organizationId: true },
  });

  for (const conta of contas) {
    await enqueue(
      {
        socialAccountId: conta.id,
        organizationId: conta.organizationId,
        correlationId: `inbox-sync:${conta.id}`,
      },
      `inbox_${conta.id}`,
    );
  }

  return contas.length;
}
