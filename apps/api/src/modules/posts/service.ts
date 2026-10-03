import {
  ConflictError,
  DEFAULT_REMOTE_STATE_WINDOW_MS,
  JOB_CHECK_REMOTE_STATE,
  JOB_PUBLISH_TARGET,
  NotFoundError,
  PLATFORM_REGISTRY,
  UNVERIFIED_OUTCOME_CODES,
  ValidationError,
  applyStaggerDelay,
  buildTargetIdempotencyKey,
  checkRemoteJobId,
  formatInTimezone,
  localIsoToUtc,
  parseSlots,
  publishJobId,
  resolveQueueSlotsForAccounts,
  validateTargets,
  type PlatformDefinition,
  type PlatformKey,
  type TargetValidationInput,
  type TargetValidationResult,
} from '@app/core';
import { readQuotaSnapshot } from '@app/platform';
import type { Container } from '../../container.js';
import { recordAudit } from '../../lib/audit.js';
import type { AuthContext } from '../../plugins/auth.js';
import { resolveVariantFor } from '../contents/service.js';
import { GroupService } from '../groups/service.js';

/**
 * Compositor e motor de agendamento (SPEC seções 6.1 e 12).
 *
 * A ideia central, e o motivo de tudo aqui girar em torno de `PostTarget`:
 * uma publicação para um grupo de 20 contas é UMA linha de `Post` e VINTE de
 * `PostTarget`, cada uma com seu horário, seu status, suas tentativas e seu
 * erro. Falha em 3 não afeta as outras 17, e "tentar novamente" reprocessa só
 * as 3 — porque cada destino é uma unidade independente do começo ao fim.
 */

export type ScheduleMode = 'SPECIFIC_TIME' | 'QUEUE_SLOT';

export interface TargetSelection {
  groupIds?: string[];
  accountIds?: string[];
}

export interface SchedulePlan {
  mode: ScheduleMode;
  /** Hora local ("2026-09-14T10:00") interpretada no fuso de CADA conta. */
  localDateTime?: string;
  /** Ajuste fino por conta, sobrepondo o horário geral. */
  perAccount?: Array<{ accountId: string; localDateTime: string }>;
  /** Espaçamento em minutos entre contas para evitar disparo simultâneo em massa (anti-spam fan-out). */
  staggerMinutes?: number;
}


export interface PreviewTarget {
  accountId: string;
  nickname: string;
  remoteDisplayName: string | null;
  platform: PlatformKey;
  platformName: string;
  timezone: string;
  accountStatus: string;
  /** Horário resolvido, em UTC. */
  scheduledAt: string | null;
  /** O mesmo horário exibido no fuso da conta, como a SPEC exige. */
  scheduledAtLocal: string | null;
  title: string | null;
  body: string;
  hashtags: string[];
  platformFields: Record<string, unknown>;
  issues: Array<{ code: string; severity: string; message: string; field?: string }>;
  canSchedule: boolean;
}

export interface PreviewResult {
  targets: PreviewTarget[];
  /** Contas que o grupo trazia mas o usuário não pode publicar. */
  excluded: Array<{ accountId: string; nickname: string; reason: string }>;
  allValid: boolean;
  /** true quando os destinos caem em instantes diferentes por causa do fuso. */
  timezoneDiverges: boolean;
  summary: { total: number; schedulable: number; blocked: number; warnings: number };
}

export class PostService {
  private readonly groups: GroupService;

  constructor(private readonly container: Container) {
    this.groups = new GroupService(container);
  }

  // -------------------------------------------------------------------------
  //  Preview — a tela que a SPEC 6.1 exige ANTES de confirmar
  // -------------------------------------------------------------------------

  async preview(
    auth: AuthContext,
    input: { contentId: string; selection: TargetSelection; schedule?: SchedulePlan },
  ): Promise<PreviewResult> {
    const content = await this.loadContent(auth, input.contentId);
    const resolved = await this.groups.resolveTargets(auth, input.selection);

    if (resolved.accounts.length === 0) {
      return {
        targets: [],
        excluded: resolved.excluded,
        allValid: false,
        timezoneDiverges: false,
        summary: { total: 0, schedulable: 0, blocked: 0, warnings: 0 },
      };
    }

    const schedules = await this.computeSchedule(auth, resolved.accounts, input.schedule);

    const validationInputs: TargetValidationInput[] = resolved.accounts.map((account) => {
      const variant = resolveVariantFor(
        { title: content.title, body: content.body, hashtags: content.hashtags },
        content.variants,
        account.platform,
        account.accountId,
      );

      return {
        targetKey: account.accountId,
        accountId: account.accountId,
        // O nome REAL do perfil, não o apelido interno: é ele que o usuário
        // precisa reconhecer antes de confirmar (SPEC seção 6.1).
        accountLabel: account.remoteDisplayName ?? account.nickname,
        platform: account.platform,
        accountStatus: account.status as TargetValidationInput['accountStatus'],
        accountTimezone: account.timezone,
        title: variant.title,
        body: variant.body,
        hashtags: variant.hashtags,
        platformFields: variant.platformFields,
        media: content.media,
        scheduledAt: schedules.get(account.accountId)?.scheduledAt ?? null,
        // A mesma regra do worker, antecipada para a tela: conteúdo de IA
        // sem revisão não pode ser agendado.
        aiNeedsReview: content.aiGenerated && content.aiReviewedAt === null,
      };
    });

    const quota = await readQuotaSnapshot(
      this.container.prisma,
      resolved.accounts.map((account) => ({
        platform: account.platform,
        socialAccountId: account.accountId,
      })),
      new Date(),
    );

    const validation = validateTargets(validationInputs, {
      definitions: PLATFORM_REGISTRY as Record<PlatformKey, PlatformDefinition>,
      configuredPlatforms: this.container.configuredPlatforms,
      quota,
      now: new Date(),
    });

    const byKey = new Map<string, TargetValidationResult>(
      validation.targets.map((result) => [result.targetKey, result]),
    );

    const targets: PreviewTarget[] = validationInputs.map((target) => {
      const schedule = schedules.get(target.accountId);
      const result = byKey.get(target.targetKey);
      const account = resolved.accounts.find((a) => a.accountId === target.accountId);

      return {
        accountId: target.accountId,
        nickname: account?.nickname ?? target.accountLabel,
        remoteDisplayName: account?.remoteDisplayName ?? null,
        platform: target.platform,
        platformName: PLATFORM_REGISTRY[target.platform].displayName,
        timezone: target.accountTimezone,
        accountStatus: target.accountStatus,
        scheduledAt: schedule?.scheduledAt?.toISOString() ?? null,
        scheduledAtLocal: schedule?.scheduledAt
          ? formatInTimezone(schedule.scheduledAt, target.accountTimezone).full
          : (schedule?.reason ?? null),
        title: target.title ?? null,
        body: target.body,
        hashtags: target.hashtags,
        platformFields: target.platformFields,
        issues: result?.issues ?? [],
        canSchedule: result?.canSchedule ?? false,
      };
    });

    const instants = new Set(
      targets.map((target) => target.scheduledAt).filter((value): value is string => value !== null),
    );

    return {
      targets,
      excluded: resolved.excluded,
      allValid: validation.allValid && targets.every((t) => t.scheduledAt !== null || !input.schedule),
      timezoneDiverges: instants.size > 1,
      summary: {
        total: targets.length,
        schedulable: targets.filter((t) => t.canSchedule).length,
        blocked: targets.filter((t) => !t.canSchedule).length,
        warnings: targets.filter((t) => t.issues.some((i) => i.severity === 'WARNING')).length,
      },
    };
  }

  // -------------------------------------------------------------------------
  //  Criação e agendamento
  // -------------------------------------------------------------------------

  /**
   * Cria a publicação e seus destinos.
   *
   * `idempotencyKey` (header Idempotency-Key) faz um reenvio da mesma
   * requisição devolver a MESMA publicação em vez de criar uma segunda
   * (SPEC seção 2). Sem isso, um duplo clique no botão "agendar" produz
   * dois posts para as mesmas 20 contas.
   */
  async create(
    auth: AuthContext,
    input: {
      contentId: string;
      selection: TargetSelection;
      schedule?: SchedulePlan;
      campaignId?: string;
      /** Agenda os destinos válidos e ignora os bloqueados. */
      allowPartial?: boolean;
      idempotencyKey?: string;
      /** Preenchido só por `duplicate()`, para manter a origem rastreável. */
      duplicatedFromId?: string;
    },
    correlationId: string,
  ): Promise<{ postId: string; preview: PreviewResult; scheduled: number; skipped: number }> {
    if (input.idempotencyKey) {
      const existing = await this.container.prisma.post.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true, organizationId: true },
      });

      if (existing) {
        if (existing.organizationId !== auth.organizationId) {
          throw new ConflictError('Esta chave de idempotência já foi usada.');
        }
        const preview = await this.previewOfExistingPost(auth, existing.id);
        return { postId: existing.id, preview, scheduled: 0, skipped: 0 };
      }
    }

    const preview = await this.preview(auth, {
      contentId: input.contentId,
      selection: input.selection,
      ...(input.schedule ? { schedule: input.schedule } : {}),
    });

    if (preview.targets.length === 0) {
      throw new ValidationError(
        'Nenhum destino disponível para esta publicação.',
        { excluidas: preview.excluded },
      );
    }

    const blocked = preview.targets.filter((target) => !target.canSchedule);
    if (blocked.length > 0 && !input.allowPartial) {
      // Falhamos com o detalhe completo em vez de agendar pela metade: quem
      // agenda precisa decidir conscientemente publicar só em parte das contas.
      throw new ValidationError(
        `${blocked.length} de ${preview.targets.length} destino(s) não podem ser agendados. ` +
          `Corrija os problemas ou confirme o agendamento parcial.`,
        {
          bloqueados: blocked.map((target) => ({
            conta: target.nickname,
            problemas: target.issues.filter((issue) => issue.severity === 'ERROR'),
          })),
        },
      );
    }

    const content = await this.loadContent(auth, input.contentId);
    const schedulable = preview.targets.filter((target) => target.canSchedule);
    const hasSchedule = Boolean(input.schedule);

    const post = await this.container.prisma.$transaction(async (tx) => {
      const created = await tx.post.create({
        data: {
          organizationId: auth.organizationId,
          clientId: content.clientId,
          contentId: input.contentId,
          campaignId: input.campaignId ?? content.campaignId,
          createdById: auth.userId,
          status: hasSchedule ? 'SCHEDULED' : 'DRAFT',
          scheduleMode: input.schedule?.mode ?? 'SPECIFIC_TIME',
          intendedScheduledAt: schedulable[0]?.scheduledAt
            ? new Date(schedulable[0].scheduledAt)
            : null,
          // Snapshot do grupo NO MOMENTO do agendamento (SPEC seção 6.1):
          // adicionar conta ao grupo depois não faz ela herdar este post.
          sourceGroupIds: input.selection.groupIds ?? [],
          groupSnapshotTakenAt: input.selection.groupIds?.length ? new Date() : null,
          idempotencyKey: input.idempotencyKey ?? null,
          duplicatedFromId: input.duplicatedFromId ?? null,
        },
      });

      await tx.postTarget.createMany({
        data: schedulable.map((target) => ({
          organizationId: auth.organizationId,
          postId: created.id,
          socialAccountId: target.accountId,
          platform: target.platform,
          status: hasSchedule ? ('SCHEDULED' as const) : ('PENDING' as const),
          scheduledAt: target.scheduledAt ? new Date(target.scheduledAt) : null,
          scheduledTimezone: target.timezone,
          // A chave é derivada de (post, conta): reprocessar um job nunca
          // publica duas vezes na mesma conta.
          idempotencyKey: buildTargetIdempotencyKey(created.id, target.accountId),
          correlationId,
          validationIssues: target.issues as unknown as object,
          validatedAt: new Date(),
        })),
      });

      return created;
    });

    if (hasSchedule) {
      await this.enqueueTargets(post.id, correlationId);
    }

    await recordAudit(this.container.prisma, {
      organizationId: auth.organizationId,
      actorUserId: auth.userId,
      action: hasSchedule ? 'post.schedule' : 'post.create_draft',
      entityType: 'Post',
      entityId: post.id,
      changes: {
        destinos: schedulable.length,
        bloqueados: blocked.length,
        grupos: input.selection.groupIds ?? [],
        modo: input.schedule?.mode ?? 'RASCUNHO',
      },
      correlationId,
    });

    return {
      postId: post.id,
      preview,
      scheduled: schedulable.length,
      skipped: blocked.length,
    };
  }

  // -------------------------------------------------------------------------
  //  Reaproveitamento de conteúdo (SPEC seção 6)
  // -------------------------------------------------------------------------

  /**
   * Duplica uma publicação para outra data e/ou outras contas.
   *
   * Três decisões que valem a explicação:
   *
   *  1. **Os destinos vêm dos `PostTarget` da origem, não dos `sourceGroupIds`.**
   *     Reexpandir o grupo faria a cópia herdar contas que entraram no grupo
   *     depois — exatamente a alteração silenciosa que a SPEC seção 6.1
   *     proíbe. Quem quiser a composição nova passa a seleção explicitamente.
   *
   *  2. **O conteúdo é COPIADO por padrão.** Se a cópia apontasse para o mesmo
   *     `Content`, editar a legenda da republicação reescreveria o texto do
   *     post original — inclusive de um que já saiu no ar. Com
   *     `reuseContent: true` o chamador aceita conscientemente o vínculo.
   *
   *  3. **A validação não é pulada.** A cópia passa pelo mesmo `preview`, e
   *     portanto pela mesma checagem de conteúdo duplicado: duplicar um post
   *     do X para uma segunda conta do X continua sendo bloqueado, porque a
   *     política de automação do X proíbe isso.
   */
  async duplicate(
    auth: AuthContext,
    sourcePostId: string,
    input: {
      selection?: TargetSelection;
      schedule?: SchedulePlan;
      campaignId?: string;
      /** Aponta para o mesmo Content em vez de copiá-lo. */
      reuseContent?: boolean;
      allowPartial?: boolean;
    },
    correlationId: string,
  ): Promise<{
    postId: string;
    contentId: string;
    duplicatedFromId: string;
    preview: PreviewResult;
    scheduled: number;
    skipped: number;
  }> {
    const source = await this.loadPost(auth, sourcePostId);

    const selection: TargetSelection =
      input.selection?.accountIds?.length || input.selection?.groupIds?.length
        ? input.selection
        : { accountIds: source.targets.map((target) => target.socialAccountId) };

    if (!selection.accountIds?.length && !selection.groupIds?.length) {
      throw new ValidationError(
        'A publicação de origem não tem destinos para reaproveitar. Escolha as contas ' +
          'de destino explicitamente.',
      );
    }

    const contentId = input.reuseContent
      ? source.contentId
      : await this.copyContent(auth, source.contentId);

    const created = await this.create(
      auth,
      {
        contentId,
        selection,
        ...(input.schedule ? { schedule: input.schedule } : {}),
        ...(input.campaignId ? { campaignId: input.campaignId } : {}),
        ...(input.allowPartial !== undefined ? { allowPartial: input.allowPartial } : {}),
        duplicatedFromId: source.id,
      },
      correlationId,
    );

    await recordAudit(this.container.prisma, {
      organizationId: auth.organizationId,
      actorUserId: auth.userId,
      action: 'post.duplicate',
      entityType: 'Post',
      entityId: created.postId,
      changes: {
        origem: source.id,
        conteudo: input.reuseContent ? 'reaproveitado' : 'copiado',
        destinos: created.scheduled,
      },
      correlationId,
    });

    return { ...created, contentId, duplicatedFromId: source.id };
  }

  /**
   * Copia um conteúdo com suas mídias e variações.
   *
   * As mídias são reaproveitadas por referência — o mesmo `MediaAsset`, não um
   * novo arquivo no storage. O arquivo é imutável depois do upload, então
   * duplicá-lo só gastaria espaço.
   *
   * `aiReviewedAt` é mantido: a cópia nasce com texto idêntico ao que um
   * humano já revisou. Qualquer edição posterior passa pelo mesmo caminho de
   * revisão do conteúdo original.
   */
  private async copyContent(auth: AuthContext, contentId: string): Promise<string> {
    const original = await this.container.prisma.content.findFirst({
      where: { id: contentId, organizationId: auth.organizationId, deletedAt: null },
      include: { media: true, variants: true },
    });

    if (!original) throw new NotFoundError('Conteúdo', contentId);

    return this.container.prisma.$transaction(async (tx) => {
      const copy = await tx.content.create({
        data: {
          organizationId: original.organizationId,
          clientId: original.clientId,
          campaignId: original.campaignId,
          // Autor da CÓPIA é quem duplicou, não quem escreveu o original.
          createdById: auth.userId,
          title: original.title,
          body: original.body,
          hashtags: original.hashtags,
          aiGenerated: original.aiGenerated,
          aiReviewedAt: original.aiReviewedAt,
        },
      });

      if (original.media.length > 0) {
        await tx.contentMedia.createMany({
          data: original.media.map((link) => ({
            contentId: copy.id,
            mediaAssetId: link.mediaAssetId,
            position: link.position,
            role: link.role,
          })),
        });
      }

      if (original.variants.length > 0) {
        await tx.contentVariant.createMany({
          data: original.variants.map((variant) => ({
            contentId: copy.id,
            organizationId: variant.organizationId,
            platform: variant.platform,
            socialAccountId: variant.socialAccountId,
            title: variant.title,
            body: variant.body,
            hashtags: variant.hashtags,
            platformFields: variant.platformFields ?? undefined,
          })),
        });
      }

      return copy.id;
    });
  }

  /** Agenda (ou reagenda) uma publicação já criada. */
  async schedule(
    auth: AuthContext,
    postId: string,
    plan: SchedulePlan,
    correlationId: string,
  ): Promise<{ scheduled: number; targets: PreviewTarget[] }> {
    const post = await this.loadPost(auth, postId);

    if (post.status === 'PUBLISHED' || post.status === 'PUBLISHING') {
      throw new ConflictError('Esta publicação já está sendo publicada ou já foi publicada.');
    }

    const accountIds = post.targets
      .filter((target) => target.status !== 'PUBLISHED' && target.deletedAt === null)
      .map((target) => target.socialAccountId);

    const preview = await this.preview(auth, {
      contentId: post.contentId,
      selection: { accountIds },
      schedule: plan,
    });

    const blocked = preview.targets.filter((target) => !target.canSchedule);
    if (blocked.length > 0) {
      throw new ValidationError(
        `${blocked.length} destino(s) não podem ser agendados neste horário.`,
        {
          bloqueados: blocked.map((target) => ({
            conta: target.nickname,
            problemas: target.issues.filter((issue) => issue.severity === 'ERROR'),
          })),
        },
      );
    }

    await this.container.prisma.$transaction(
      preview.targets.map((target) =>
        this.container.prisma.postTarget.updateMany({
          where: {
            postId,
            socialAccountId: target.accountId,
            status: { notIn: ['PUBLISHED', 'PUBLISHING'] },
          },
          data: {
            status: 'SCHEDULED',
            scheduledAt: target.scheduledAt ? new Date(target.scheduledAt) : null,
            scheduledTimezone: target.timezone,
            validationIssues: target.issues as unknown as object,
            validatedAt: new Date(),
            errorCode: null,
            errorMessage: null,
            errorPermanent: false,
          },
        }),
      ),
    );

    await this.container.prisma.post.update({
      where: { id: postId },
      data: {
        status: 'SCHEDULED',
        scheduleMode: plan.mode,
        intendedScheduledAt: preview.targets[0]?.scheduledAt
          ? new Date(preview.targets[0].scheduledAt)
          : null,
      },
    });

    await this.enqueueTargets(postId, correlationId);

    await recordAudit(this.container.prisma, {
      organizationId: auth.organizationId,
      actorUserId: auth.userId,
      action: 'post.schedule',
      entityType: 'Post',
      entityId: postId,
      changes: { destinos: preview.targets.length, modo: plan.mode },
      correlationId,
    });

    return { scheduled: preview.targets.length, targets: preview.targets };
  }

  /**
   * Reprocessa APENAS os destinos que falharam.
   *
   * Cenário obrigatório da SPEC seção 21: num grupo de 20 contas em que 3
   * falham, "tentar novamente" toca só nas 3 — as 17 publicadas não são
   * republicadas, garantido pelo filtro de status e pela UNIQUE do destino.
   *
   * Resultado DESCONHECIDO é tratado à parte: quando a criação chegou a sair
   * (ou pode ter saído) sem confirmação, reenviar às cegas publicaria duas
   * vezes. O que se faz depende do que sobrou da tentativa:
   *
   *  - há identificador da operação remota (REMOTE_PROCESSING_TIMEOUT e
   *    afins): NÃO se recria nada — retoma-se a VERIFICAÇÃO do estado remoto,
   *    que confirma ou conclui o destino sem novo upload;
   *  - não há identificador (PUBLISH_INTERRUPTED_UNVERIFIED): só uma pessoa
   *    pode decidir reenviar, com o risco declarado — por isso o retry exige
   *    `acknowledgeUnverified`, e a concordância vai para a auditoria.
   */
  async retryFailed(
    auth: AuthContext,
    postId: string,
    correlationId: string,
    onlyTargetIds?: string[],
    options?: { acknowledgeUnverified?: boolean },
  ): Promise<{
    retried: number;
    resumedVerification: number;
    targets: Array<{ accountNickname: string; scheduledAt: string }>;
  }> {
    const post = await this.loadPost(auth, postId);

    const failed = post.targets.filter(
      (target) =>
        target.status === 'FAILED' &&
        target.deletedAt === null &&
        (!onlyTargetIds || onlyTargetIds.includes(target.id)),
    );

    if (failed.length === 0) {
      throw new ValidationError('Não há destinos com falha para reprocessar nesta publicação.');
    }

    /**
     * Destinos com verificação retomável têm o identificador da operação
     * remota — a consulta ao estado substitui o reenvio. Os demais códigos
     * de resultado desconhecido (sem identificador, ex.: worker morto no
     * meio do upload) só voltam à fila por decisão explícita.
     */
    const COM_VERIFICACAO_RETROMAVEL = new Set([
      'REMOTE_PROCESSING_TIMEOUT',
      'REMOTE_STATE_CHECK_FAILED',
    ]);

    const retomavel = failed.filter(
      (target) =>
        target.errorCode !== null &&
        COM_VERIFICACAO_RETROMAVEL.has(target.errorCode) &&
        target.remoteOperationId !== null,
    );
    const inconclusivo = failed.filter(
      (target) =>
        target.errorCode !== null &&
        UNVERIFIED_OUTCOME_CODES.has(target.errorCode) &&
        !retomavel.includes(target),
    );
    const confirmado = failed.filter(
      (target) => !retomavel.includes(target) && !inconclusivo.includes(target),
    );

    if (inconclusivo.length > 0 && options?.acknowledgeUnverified !== true) {
      throw new ValidationError(
        `${inconclusivo.length} destino(s) tiveram resultado DESCONHECIDO: o envio chegou a sair ` +
          'e não foi possível confirmar se a publicação aconteceu. Reenviar às cegas pode ' +
          'publicar o mesmo conteúdo duas vezes. Confira a conta na plataforma e, se ela não ' +
          'tiver saído, repita a operação confirmando que entende o risco.',
        {
          code: 'UNVERIFIED_RETRY_REQUIRES_ACK',
          destinos: inconclusivo.map((target) => ({
            targetId: target.id,
            conta: target.socialAccount.nickname,
            erro: target.errorCode,
          })),
        },
      );
    }

    const now = new Date();

    // Destinos com falha confirmada voltam à fila de publicação.
    if (confirmado.length > 0) {
      await this.container.prisma.postTarget.updateMany({
        where: { id: { in: confirmado.map((target) => target.id) } },
        data: {
          status: 'SCHEDULED',
          scheduledAt: now,
          // Zera o contador: é uma nova rodada pedida por uma pessoa, não a
          // continuação do retry automático que já esgotou.
          attempts: 0,
          nextRetryAt: null,
          errorCode: null,
          errorMessage: null,
          errorPermanent: false,
          remoteOperationId: null,
          processingDeadlineAt: null,
        },
      });
      await this.enqueueTargets(postId, correlationId, confirmado.map((target) => target.id));
    }

    // Destinos inconclusivos CONFIRMADOS pela pessoa também voltam à fila —
    // a concordância fica registrada na auditoria abaixo.
    if (inconclusivo.length > 0) {
      await this.container.prisma.postTarget.updateMany({
        where: { id: { in: inconclusivo.map((target) => target.id) } },
        data: {
          status: 'SCHEDULED',
          scheduledAt: now,
          attempts: 0,
          nextRetryAt: null,
          errorCode: null,
          errorMessage: null,
          errorPermanent: false,
          remoteOperationId: null,
          processingDeadlineAt: null,
        },
      });
      await this.enqueueTargets(postId, correlationId, inconclusivo.map((target) => target.id));
    }

    // Destinos com verificação retomável voltam a PROCESSING com novo prazo
    // e NENHUM upload novo: só a consulta ao estado remoto roda de novo.
    for (const target of retomavel) {
      await this.container.prisma.postTarget.update({
        where: { id: target.id },
        data: {
          status: 'PROCESSING',
          processingDeadlineAt: new Date(now.getTime() + DEFAULT_REMOTE_STATE_WINDOW_MS),
          nextRetryAt: null,
          errorCode: null,
          errorMessage: null,
          errorPermanent: false,
          jobId: checkRemoteJobId(target.id),
        },
      });

      await this.container.queues.publish.add(
        JOB_CHECK_REMOTE_STATE,
        {
          postTargetId: target.id,
          organizationId: target.organizationId,
          attempt: 0,
          correlationId,
        },
        {
          jobId: checkRemoteJobId(target.id),
          delay: 0,
          attempts: 10,
          backoff: { type: 'exponential', delay: 30_000 },
          removeOnComplete: true,
        },
      );
    }

    await this.recomputePostStatus(postId);

    await recordAudit(this.container.prisma, {
      organizationId: auth.organizationId,
      actorUserId: auth.userId,
      action: 'post.retry_failed',
      entityType: 'Post',
      entityId: postId,
      changes: {
        destinos: confirmado.length + inconclusivo.length,
        verificacoesRetomadas: retomavel.length,
        ...(inconclusivo.length > 0 ? { reconheceuResultadoDesconhecido: true } : {}),
      },
      correlationId,
    });

    return {
      retried: confirmado.length + inconclusivo.length,
      resumedVerification: retomavel.length,
      targets: confirmado.map((target) => ({
        accountNickname: target.socialAccount.nickname,
        scheduledAt: now.toISOString(),
      })),
    };
  }

  async cancel(
    auth: AuthContext,
    postId: string,
    correlationId: string,
    onlyTargetIds?: string[],
  ): Promise<{ cancelled: number }> {
    const post = await this.loadPost(auth, postId);

    const cancellable = post.targets.filter(
      (target) =>
        ['PENDING', 'SCHEDULED', 'QUEUED'].includes(target.status) &&
        target.deletedAt === null &&
        (!onlyTargetIds || onlyTargetIds.includes(target.id)),
    );

    if (cancellable.length === 0) {
      throw new ValidationError(
        'Não há destinos pendentes para cancelar. Destinos já publicados não podem ser desfeitos por aqui.',
      );
    }

    // Remover o job da fila ANTES de mudar o status: na ordem inversa, o
    // worker poderia pegar o job no intervalo e publicar um destino cancelado.
    for (const target of cancellable) {
      const job = await this.container.queues.publish.getJob(publishJobId(target.id));
      if (job) await job.remove().catch(() => undefined);
    }

    await this.container.prisma.postTarget.updateMany({
      where: { id: { in: cancellable.map((target) => target.id) } },
      data: { status: 'CANCELLED', cancelledAt: new Date(), jobId: null },
    });

    await this.recomputePostStatus(postId);

    await recordAudit(this.container.prisma, {
      organizationId: auth.organizationId,
      actorUserId: auth.userId,
      action: 'post.cancel',
      entityType: 'Post',
      entityId: postId,
      changes: { destinos: cancellable.length },
      correlationId,
    });

    return { cancelled: cancellable.length };
  }

  /**
   * Aplica a composição ATUAL de um grupo aos agendamentos futuros.
   *
   * Ação explícita, nunca automática (SPEC seção 6.1). Devolve o preview do
   * que mudaria para a UI confirmar antes.
   */
  async applyGroupChangeToFuture(
    auth: AuthContext,
    groupId: string,
    correlationId: string,
    dryRun: boolean,
  ): Promise<{
    posts: Array<{
      postId: string;
      contentTitle: string | null;
      toAdd: string[];
      toRemove: string[];
    }>;
    applied: boolean;
  }> {
    const group = await this.groups.get(auth, groupId);
    const currentIds = new Set(group.members.map((member) => member.accountId));

    const posts = await this.container.prisma.post.findMany({
      where: {
        organizationId: auth.organizationId,
        deletedAt: null,
        sourceGroupIds: { has: groupId },
        targets: {
          some: {
            status: { in: ['PENDING', 'SCHEDULED', 'QUEUED'] },
            scheduledAt: { gt: new Date() },
            deletedAt: null,
          },
        },
      },
      include: {
        content: { select: { title: true } },
        targets: {
          where: { deletedAt: null },
          include: { socialAccount: { select: { id: true, nickname: true, timezone: true } } },
        },
      },
    });

    const plan = posts.map((post) => {
      const existing = new Set(
        post.targets
          .filter((target) => target.status !== 'CANCELLED')
          .map((target) => target.socialAccountId),
      );

      const toAdd = [...currentIds].filter((id) => !existing.has(id));
      const toRemove = post.targets
        .filter(
          (target) =>
            !currentIds.has(target.socialAccountId) &&
            ['PENDING', 'SCHEDULED', 'QUEUED'].includes(target.status),
        )
        .map((target) => target.socialAccountId);

      return { post, toAdd, toRemove };
    });

    const summary = plan.map((entry) => ({
      postId: entry.post.id,
      contentTitle: entry.post.content.title,
      toAdd: entry.toAdd.map(
        (id) => group.members.find((member) => member.accountId === id)?.nickname ?? id,
      ),
      toRemove: entry.toRemove.map(
        (id) =>
          entry.post.targets.find((target) => target.socialAccountId === id)?.socialAccount
            .nickname ?? id,
      ),
    }));

    if (dryRun) return { posts: summary, applied: false };

    for (const entry of plan) {
      if (entry.toAdd.length > 0) {
        const reference = entry.post.targets.find((target) => target.scheduledAt !== null);

        await this.container.prisma.postTarget.createMany({
          data: entry.toAdd.map((accountId) => {
            const member = group.members.find((m) => m.accountId === accountId);
            return {
              organizationId: auth.organizationId,
              postId: entry.post.id,
              socialAccountId: accountId,
              platform: (member?.platform ?? 'YOUTUBE') as PlatformKey,
              status: 'SCHEDULED' as const,
              scheduledAt: reference?.scheduledAt ?? entry.post.intendedScheduledAt,
              scheduledTimezone: member?.timezone ?? null,
              idempotencyKey: buildTargetIdempotencyKey(entry.post.id, accountId),
              correlationId,
            };
          }),
          skipDuplicates: true,
        });
      }

      if (entry.toRemove.length > 0) {
        await this.cancel(
          auth,
          entry.post.id,
          correlationId,
          entry.post.targets
            .filter((target) => entry.toRemove.includes(target.socialAccountId))
            .map((target) => target.id),
        );
      }

      await this.enqueueTargets(entry.post.id, correlationId);
    }

    await recordAudit(this.container.prisma, {
      organizationId: auth.organizationId,
      actorUserId: auth.userId,
      action: 'group.applied_to_future_schedules',
      entityType: 'AccountGroup',
      entityId: groupId,
      changes: { publicacoes: summary.length },
      correlationId,
    });

    return { posts: summary, applied: true };
  }

  // -------------------------------------------------------------------------
  //  Enfileiramento
  // -------------------------------------------------------------------------

  /**
   * Enfileira um job POR DESTINO, com `jobId` determinístico.
   *
   * O `jobId` é a segunda linha de defesa contra duplicação: o BullMQ ignora
   * um job cujo id já existe, então enfileirar duas vezes o mesmo destino
   * (dupla submissão, reagendamento, corrida entre réplicas da API) resulta
   * em um job só. A primeira linha continua sendo a UNIQUE no banco.
   */
  private async enqueueTargets(
    postId: string,
    correlationId: string,
    onlyTargetIds?: string[],
  ): Promise<void> {
    const targets = await this.container.prisma.postTarget.findMany({
      where: {
        postId,
        status: 'SCHEDULED',
        deletedAt: null,
        ...(onlyTargetIds ? { id: { in: onlyTargetIds } } : {}),
      },
      select: {
        id: true,
        organizationId: true,
        platform: true,
        scheduledAt: true,
        idempotencyKey: true,
        maxAttempts: true,
      },
    });

    const now = Date.now();

    for (const target of targets) {
      const delay = Math.max(0, (target.scheduledAt?.getTime() ?? now) - now);
      const jobId = publishJobId(target.id);

      // Um job antigo do mesmo destino (de um agendamento anterior) precisa
      // sair, senão o horário velho continuaria valendo.
      const existing = await this.container.queues.publish.getJob(jobId);
      if (existing) await existing.remove().catch(() => undefined);

      await this.container.queues.publish.add(
        JOB_PUBLISH_TARGET,
        {
          postTargetId: target.id,
          organizationId: target.organizationId,
          platform: target.platform,
          idempotencyKey: target.idempotencyKey,
          correlationId,
        },
        {
          jobId,
          delay,
          attempts: target.maxAttempts,
          // O backoff real é decidido pelo worker (que sabe distinguir erro
          // recuperável de permanente); este é só o piso do BullMQ.
          backoff: { type: 'exponential', delay: 30_000 },
        },
      );

      await this.container.prisma.postTarget.update({
        where: { id: target.id },
        data: { jobId, status: 'QUEUED' },
      });
    }
  }

  // -------------------------------------------------------------------------
  //  Auxiliares
  // -------------------------------------------------------------------------

  /**
   * Resolve o horário de cada destino.
   *
   * A conversão é feita conta a conta, no fuso da conta: "segunda às 10h"
   * para uma conta em São Paulo e outra em Lisboa são dois instantes UTC
   * diferentes, e é assim que tem que ser (SPEC seção 6.1).
   */
  private async computeSchedule(
    auth: AuthContext,
    accounts: Array<{ accountId: string; nickname: string; timezone: string }>,
    plan?: SchedulePlan,
  ): Promise<Map<string, { scheduledAt: Date | null; reason?: string }>> {
    const result = new Map<string, { scheduledAt: Date | null; reason?: string }>();

    if (!plan) {
      for (const account of accounts) result.set(account.accountId, { scheduledAt: null });
      return result;
    }

    if (plan.mode === 'SPECIFIC_TIME') {
      const perAccount = new Map(
        (plan.perAccount ?? []).map((entry) => [entry.accountId, entry.localDateTime]),
      );

      let targetIndex = 0;
      for (const account of accounts) {
        const localDateTime = perAccount.get(account.accountId) ?? plan.localDateTime;

        if (!localDateTime) {
          result.set(account.accountId, {
            scheduledAt: null,
            reason: 'Horário não informado para esta conta.',
          });
          continue;
        }

        const baseScheduledAt = localIsoToUtc(localDateTime, account.timezone);
        const scheduledAt = applyStaggerDelay(baseScheduledAt, targetIndex, plan.staggerMinutes);
        targetIndex++;

        result.set(account.accountId, {
          scheduledAt,
        });
      }

      return result;
    }

    // Fila por slots: cada conta usa a própria grade e os próprios horários
    // já ocupados.
    const schedules = await this.container.prisma.postingSchedule.findMany({
      where: {
        socialAccountId: { in: accounts.map((account) => account.accountId) },
        organizationId: auth.organizationId,
      },
      select: { socialAccountId: true, slots: true, isEnabled: true },
    });

    const occupied = await this.container.prisma.postTarget.findMany({
      where: {
        socialAccountId: { in: accounts.map((account) => account.accountId) },
        status: { in: ['PENDING', 'SCHEDULED', 'QUEUED'] },
        scheduledAt: { gte: new Date() },
        deletedAt: null,
      },
      select: { socialAccountId: true, scheduledAt: true },
    });

    const slotsByAccount = new Map(
      schedules.map((schedule) => [
        schedule.socialAccountId,
        schedule.isEnabled ? parseSlots(schedule.slots) : [],
      ]),
    );

    const occupiedByAccount = new Map<string, Date[]>();
    for (const target of occupied) {
      if (!target.scheduledAt) continue;
      const list = occupiedByAccount.get(target.socialAccountId) ?? [];
      list.push(target.scheduledAt);
      occupiedByAccount.set(target.socialAccountId, list);
    }

    const resolutions = resolveQueueSlotsForAccounts(
      accounts.map((account) => ({
        accountId: account.accountId,
        accountLabel: account.nickname,
        timezone: account.timezone,
        slots: slotsByAccount.get(account.accountId) ?? [],
        occupied: occupiedByAccount.get(account.accountId) ?? [],
      })),
      new Date(),
    );

    for (const resolution of resolutions) {
      result.set(resolution.accountId, {
        scheduledAt: resolution.scheduledAt,
        ...(resolution.reason ? { reason: resolution.reason } : {}),
      });
    }

    return result;
  }

  private async loadContent(auth: AuthContext, contentId: string) {
    const content = await this.container.prisma.content.findFirst({
      where: { id: contentId, organizationId: auth.organizationId, deletedAt: null },
      include: {
        media: { include: { mediaAsset: true }, orderBy: { position: 'asc' } },
        variants: true,
      },
    });

    if (!content) throw new NotFoundError('Conteúdo', contentId);

    return {
      ...content,
      media: content.media.map((link) => ({
        mediaAssetId: link.mediaAssetId,
        filename: link.mediaAsset.originalFilename,
        mimeType: link.mediaAsset.mimeType,
        type: link.mediaAsset.type,
        sizeBytes: Number(link.mediaAsset.sizeBytes),
        durationMs: link.mediaAsset.durationMs,
        width: link.mediaAsset.width,
        height: link.mediaAsset.height,
        processingStatus: link.mediaAsset.processingStatus,
      })),
    };
  }

  private async loadPost(auth: AuthContext, postId: string) {
    const post = await this.container.prisma.post.findFirst({
      where: { id: postId, organizationId: auth.organizationId, deletedAt: null },
      include: {
        targets: {
          include: { socialAccount: { select: { nickname: true, timezone: true } } },
        },
      },
    });
    if (!post) throw new NotFoundError('Publicação', postId);
    return post;
  }

  private async previewOfExistingPost(
    auth: AuthContext,
    postId: string,
  ): Promise<PreviewResult> {
    const post = await this.loadPost(auth, postId);
    return this.preview(auth, {
      contentId: post.contentId,
      selection: { accountIds: post.targets.map((target) => target.socialAccountId) },
    });
  }

  /**
   * Recalcula o status agregado do post a partir dos destinos.
   *
   * O `Post.status` é derivado, nunca a fonte da verdade: quem sabe se
   * publicou é o destino. `PARTIALLY_PUBLISHED` existe justamente para o caso
   * de 17 sucessos e 3 falhas não virar nem "publicado" nem "falhou".
   */
  async recomputePostStatus(postId: string): Promise<void> {
    const targets = await this.container.prisma.postTarget.findMany({
      where: { postId, deletedAt: null },
      select: { status: true, publishedAt: true },
    });

    if (targets.length === 0) return;

    const counts = targets.reduce<Record<string, number>>((accumulator, target) => {
      accumulator[target.status] = (accumulator[target.status] ?? 0) + 1;
      return accumulator;
    }, {});

    const total = targets.length;
    const published = counts['PUBLISHED'] ?? 0;
    const failed = counts['FAILED'] ?? 0;
    const cancelled = counts['CANCELLED'] ?? 0;
    const publishing = counts['PUBLISHING'] ?? 0;
    // PROCESSING = a plataforma aceitou mas ainda não confirmou: o post
    // continua "em publicação" até o desfecho remoto.
    const processing = counts['PROCESSING'] ?? 0;
    const skipped = counts['SKIPPED'] ?? 0;

    let status: string;
    if (publishing + processing > 0) status = 'PUBLISHING';
    else if (published === total) status = 'PUBLISHED';
    else if (cancelled === total) status = 'CANCELLED';
    else if (failed + skipped === total) status = 'FAILED';
    else if (published > 0 && published + failed + cancelled + skipped === total) {
      status = 'PARTIALLY_PUBLISHED';
    } else status = 'SCHEDULED';

    const publishedAt = targets
      .map((target) => target.publishedAt)
      .filter((date): date is Date => date !== null)
      .sort((a, b) => a.getTime() - b.getTime())[0];

    await this.container.prisma.post.update({
      where: { id: postId },
      data: {
        status: status as never,
        ...(publishedAt ? { publishedAt } : {}),
      },
    });
  }
}
