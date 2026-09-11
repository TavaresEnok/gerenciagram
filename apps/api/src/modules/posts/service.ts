import {
  ConflictError,
  JOB_PUBLISH_TARGET,
  NotFoundError,
  PLATFORM_REGISTRY,
  ValidationError,
  buildTargetIdempotencyKey,
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
   */
  async retryFailed(
    auth: AuthContext,
    postId: string,
    correlationId: string,
    onlyTargetIds?: string[],
  ): Promise<{ retried: number; targets: Array<{ accountNickname: string; scheduledAt: string }> }> {
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

    const now = new Date();

    await this.container.prisma.postTarget.updateMany({
      where: { id: { in: failed.map((target) => target.id) } },
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
      },
    });

    await this.enqueueTargets(postId, correlationId, failed.map((target) => target.id));

    await recordAudit(this.container.prisma, {
      organizationId: auth.organizationId,
      actorUserId: auth.userId,
      action: 'post.retry_failed',
      entityType: 'Post',
      entityId: postId,
      changes: { destinos: failed.length },
      correlationId,
    });

    return {
      retried: failed.length,
      targets: failed.map((target) => ({
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

        let scheduledAt = localIsoToUtc(localDateTime, account.timezone);
        if (plan.staggerMinutes && plan.staggerMinutes > 0 && targetIndex > 0) {
          scheduledAt = new Date(scheduledAt.getTime() + targetIndex * plan.staggerMinutes * 60_000);
        }
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
    const skipped = counts['SKIPPED'] ?? 0;

    let status: string;
    if (publishing > 0) status = 'PUBLISHING';
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
