import {
  ConflictError,
  NotFoundError,
  ValidationError,
  filterAccountsUserCanPublishTo,
  formatSlot,
  getPlatformDefinition,
  normalizeSlots,
  parseSlots,
  type PlatformKey,
  type QueueSlot,
} from '@app/core';
import type { Container } from '../../container.js';
import { recordAudit } from '../../lib/audit.js';
import type { AuthContext } from '../../plugins/auth.js';

/**
 * Grupos de contas (SPEC seção 6.1).
 *
 * O grupo é um ATALHO DE SELEÇÃO transversal à hierarquia — não um nível
 * dela. Duas consequências que este módulo garante:
 *
 *  1. Grupo NUNCA concede permissão. Ao resolver um grupo em destinos, ficam
 *     só as contas em que o usuário pode publicar, e as excluídas voltam
 *     nomeadas para a UI mostrar quem ficou de fora.
 *  2. A grade de horários da fila mora na CONTA, não no grupo. O grupo é só
 *     um atalho para configurar várias contas de uma vez — o fuso é da conta,
 *     então a grade tem que ser dela.
 */

export interface GroupView {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  memberCount: number;
  /** Quantas contas de cada rede, para a UI resumir sem carregar tudo. */
  countByPlatform: Record<string, number>;
  members: Array<{
    accountId: string;
    nickname: string;
    platform: PlatformKey;
    platformName: string;
    clientId: string;
    clientName: string;
    timezone: string;
    status: string;
    remoteDisplayName: string | null;
    remoteAvatarUrl: string | null;
  }>;
  createdAt: string;
}

/** Resultado de resolver um grupo (ou lista de contas) em destinos reais. */
export interface ResolvedTargets {
  accounts: Array<{
    accountId: string;
    nickname: string;
    platform: PlatformKey;
    clientId: string;
    timezone: string;
    status: string;
    remoteDisplayName: string | null;
  }>;
  excluded: Array<{ accountId: string; nickname: string; reason: string }>;
}

export class GroupService {
  constructor(private readonly container: Container) {}

  async list(auth: AuthContext): Promise<GroupView[]> {
    const groups = await this.container.prisma.accountGroup.findMany({
      where: { organizationId: auth.organizationId, deletedAt: null },
      include: {
        members: {
          include: {
            socialAccount: {
              include: { client: { select: { id: true, name: true } } },
            },
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    return groups.map((group) => this.toView(group, auth));
  }

  async get(auth: AuthContext, groupId: string): Promise<GroupView> {
    const group = await this.container.prisma.accountGroup.findFirst({
      where: { id: groupId, organizationId: auth.organizationId, deletedAt: null },
      include: {
        members: {
          include: {
            socialAccount: {
              include: { client: { select: { id: true, name: true } } },
            },
          },
        },
      },
    });

    if (!group) throw new NotFoundError('Grupo de contas', groupId);
    return this.toView(group, auth);
  }

  async create(
    auth: AuthContext,
    input: { name: string; description?: string; color?: string; accountIds: string[] },
    correlationId: string,
  ): Promise<GroupView> {
    const existing = await this.container.prisma.accountGroup.findFirst({
      where: { organizationId: auth.organizationId, name: input.name.trim(), deletedAt: null },
    });
    if (existing) throw new ConflictError(`Já existe um grupo chamado "${input.name}".`);

    const accounts = await this.loadAccounts(auth, input.accountIds);

    const group = await this.container.prisma.accountGroup.create({
      data: {
        organizationId: auth.organizationId,
        name: input.name.trim(),
        description: input.description ?? null,
        color: input.color ?? null,
        members: {
          create: accounts.map((account) => ({
            socialAccountId: account.id,
            organizationId: auth.organizationId,
          })),
        },
      },
    });

    await recordAudit(this.container.prisma, {
      organizationId: auth.organizationId,
      actorUserId: auth.userId,
      action: 'group.create',
      entityType: 'AccountGroup',
      entityId: group.id,
      changes: { name: group.name, contas: accounts.length },
      correlationId,
    });

    return this.get(auth, group.id);
  }

  async update(
    auth: AuthContext,
    groupId: string,
    input: { name?: string; description?: string | null; color?: string | null },
    correlationId: string,
  ): Promise<GroupView> {
    const group = await this.container.prisma.accountGroup.findFirst({
      where: { id: groupId, organizationId: auth.organizationId, deletedAt: null },
    });
    if (!group) throw new NotFoundError('Grupo de contas', groupId);

    await this.container.prisma.accountGroup.update({
      where: { id: groupId },
      data: {
        ...(input.name ? { name: input.name.trim() } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
      },
    });

    await recordAudit(this.container.prisma, {
      organizationId: auth.organizationId,
      actorUserId: auth.userId,
      action: 'group.update',
      entityType: 'AccountGroup',
      entityId: groupId,
      changes: input,
      correlationId,
    });

    return this.get(auth, groupId);
  }

  /**
   * Altera a composição do grupo.
   *
   * Ponto central da SPEC seção 6.1: mexer no grupo NÃO altera agendamento
   * já feito. Devolvemos quantos agendamentos futuros existem para que a UI
   * ofereça a ação explícita "aplicar esta mudança aos agendamentos futuros"
   * — nunca aplicando sozinha.
   */
  async setMembers(
    auth: AuthContext,
    groupId: string,
    accountIds: string[],
    correlationId: string,
  ): Promise<{ group: GroupView; futureSchedulesAffected: number }> {
    const group = await this.container.prisma.accountGroup.findFirst({
      where: { id: groupId, organizationId: auth.organizationId, deletedAt: null },
      include: { members: true },
    });
    if (!group) throw new NotFoundError('Grupo de contas', groupId);

    const accounts = await this.loadAccounts(auth, accountIds);
    const nextIds = new Set(accounts.map((account) => account.id));
    const previousIds = new Set(group.members.map((member) => member.socialAccountId));

    const added = [...nextIds].filter((id) => !previousIds.has(id));
    const removed = [...previousIds].filter((id) => !nextIds.has(id));

    await this.container.prisma.$transaction([
      this.container.prisma.accountGroupMember.deleteMany({
        where: { accountGroupId: groupId, socialAccountId: { in: removed } },
      }),
      this.container.prisma.accountGroupMember.createMany({
        data: added.map((socialAccountId) => ({
          accountGroupId: groupId,
          socialAccountId,
          organizationId: auth.organizationId,
        })),
        skipDuplicates: true,
      }),
    ]);

    // Agendamentos futuros criados a partir DESTE grupo. Não tocamos em
    // nenhum deles: só contamos, para a UI poder avisar.
    const futureSchedulesAffected = await this.container.prisma.post.count({
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
    });

    await recordAudit(this.container.prisma, {
      organizationId: auth.organizationId,
      actorUserId: auth.userId,
      action: 'group.members_changed',
      entityType: 'AccountGroup',
      entityId: groupId,
      changes: {
        adicionadas: added.length,
        removidas: removed.length,
        agendamentosFuturosNaoAlterados: futureSchedulesAffected,
      },
      correlationId,
    });

    return { group: await this.get(auth, groupId), futureSchedulesAffected };
  }

  async remove(auth: AuthContext, groupId: string, correlationId: string): Promise<void> {
    const group = await this.container.prisma.accountGroup.findFirst({
      where: { id: groupId, organizationId: auth.organizationId, deletedAt: null },
    });
    if (!group) throw new NotFoundError('Grupo de contas', groupId);

    // Soft-delete. Posts agendados guardam `sourceGroupIds`, e apagar o grupo
    // de vez tornaria impossível explicar de onde vieram aqueles destinos.
    await this.container.prisma.accountGroup.update({
      where: { id: groupId },
      data: { deletedAt: new Date() },
    });

    await recordAudit(this.container.prisma, {
      organizationId: auth.organizationId,
      actorUserId: auth.userId,
      action: 'group.delete',
      entityType: 'AccountGroup',
      entityId: groupId,
      changes: { name: group.name },
      correlationId,
    });
  }

  /**
   * Resolve grupos + contas avulsas na lista final de destinos.
   *
   * É esta função que o compositor usa para o preview exigido pela SPEC
   * ("mostra a lista resolvida de destinos, conta por conta, com o nome real
   * de cada perfil"), e é a mesma que o agendamento usa — para o que o
   * usuário viu na tela ser exatamente o que será agendado.
   */
  async resolveTargets(
    auth: AuthContext,
    input: { groupIds?: string[]; accountIds?: string[] },
  ): Promise<ResolvedTargets> {
    const fromGroups = input.groupIds?.length
      ? await this.container.prisma.accountGroupMember.findMany({
          where: {
            accountGroupId: { in: input.groupIds },
            accountGroup: { organizationId: auth.organizationId, deletedAt: null },
          },
          select: { socialAccountId: true },
        })
      : [];

    const candidateIds = [
      ...new Set([
        ...fromGroups.map((member) => member.socialAccountId),
        ...(input.accountIds ?? []),
      ]),
    ];

    if (candidateIds.length === 0) {
      return { accounts: [], excluded: [] };
    }

    const accounts = await this.container.prisma.socialAccount.findMany({
      where: {
        id: { in: candidateIds },
        organizationId: auth.organizationId,
        deletedAt: null,
      },
      select: {
        id: true,
        nickname: true,
        platform: true,
        clientId: true,
        timezone: true,
        status: true,
        remoteDisplayName: true,
      },
      orderBy: [{ platform: 'asc' }, { nickname: 'asc' }],
    });

    // A permissão é checada AQUI, sobre a conta — nunca sobre o grupo.
    const { allowed, denied } = filterAccountsUserCanPublishTo(
      accounts.map((account) => ({
        ...account,
        accountId: account.id,
      })),
      auth.role,
      auth.scopedClientIds,
    );

    return {
      accounts: allowed.map((account) => ({
        accountId: account.id,
        nickname: account.nickname,
        platform: account.platform,
        clientId: account.clientId,
        timezone: account.timezone,
        status: account.status,
        remoteDisplayName: account.remoteDisplayName,
      })),
      excluded: denied.map((entry) => ({
        accountId: entry.account.id,
        nickname: entry.account.nickname,
        reason: entry.reason,
      })),
    };
  }

  // -------------------------------------------------------------------------
  //  Grade de horários da fila
  // -------------------------------------------------------------------------

  /**
   * Aplica uma grade semanal às contas do grupo.
   *
   * A grade é gravada em CADA conta, não no grupo: os horários são
   * interpretados no fuso da conta, então "segunda às 10h" aplicado a um
   * grupo com contas em São Paulo e em Lisboa gera dois instantes diferentes
   * — que é o comportamento correto (SPEC seção 6.1).
   */
  async applyScheduleToGroup(
    auth: AuthContext,
    groupId: string,
    slots: QueueSlot[],
    correlationId: string,
  ): Promise<{ accountsUpdated: number; preview: Array<{ nickname: string; timezone: string; slots: string[] }> }> {
    const resolved = await this.resolveTargets(auth, { groupIds: [groupId] });

    if (resolved.accounts.length === 0) {
      throw new ValidationError(
        'Nenhuma conta deste grupo está disponível para você configurar.',
        { excluidas: resolved.excluded },
      );
    }

    const normalized = normalizeSlots(parseSlots(slots));

    await this.container.prisma.$transaction(
      resolved.accounts.map((account) =>
        this.container.prisma.postingSchedule.upsert({
          where: { socialAccountId: account.accountId },
          create: {
            socialAccountId: account.accountId,
            organizationId: auth.organizationId,
            slots: normalized as unknown as object,
            isEnabled: true,
          },
          update: { slots: normalized as unknown as object, isEnabled: true },
        }),
      ),
    );

    await recordAudit(this.container.prisma, {
      organizationId: auth.organizationId,
      actorUserId: auth.userId,
      action: 'group.schedule_applied',
      entityType: 'AccountGroup',
      entityId: groupId,
      changes: { contas: resolved.accounts.length, slots: normalized.length },
      correlationId,
    });

    return {
      accountsUpdated: resolved.accounts.length,
      preview: resolved.accounts.map((account) => ({
        nickname: account.nickname,
        timezone: account.timezone,
        slots: normalized.map(formatSlot),
      })),
    };
  }

  async setAccountSchedule(
    auth: AuthContext,
    accountId: string,
    slots: QueueSlot[],
    isEnabled: boolean,
    correlationId: string,
  ): Promise<{ slots: QueueSlot[]; timezone: string }> {
    const account = await this.container.prisma.socialAccount.findFirst({
      where: { id: accountId, organizationId: auth.organizationId, deletedAt: null },
      select: { id: true, timezone: true, clientId: true },
    });
    if (!account) throw new NotFoundError('Conta conectada', accountId);

    const normalized = normalizeSlots(parseSlots(slots));

    await this.container.prisma.postingSchedule.upsert({
      where: { socialAccountId: accountId },
      create: {
        socialAccountId: accountId,
        organizationId: auth.organizationId,
        slots: normalized as unknown as object,
        isEnabled,
      },
      update: { slots: normalized as unknown as object, isEnabled },
    });

    await recordAudit(this.container.prisma, {
      organizationId: auth.organizationId,
      actorUserId: auth.userId,
      action: 'account.schedule_updated',
      entityType: 'SocialAccount',
      entityId: accountId,
      changes: { slots: normalized.length, isEnabled },
      correlationId,
    });

    return { slots: normalized, timezone: account.timezone };
  }

  // -------------------------------------------------------------------------

  private async loadAccounts(
    auth: AuthContext,
    accountIds: string[],
  ): Promise<Array<{ id: string }>> {
    if (accountIds.length === 0) return [];

    const accounts = await this.container.prisma.socialAccount.findMany({
      where: {
        id: { in: accountIds },
        organizationId: auth.organizationId,
        deletedAt: null,
        ...(auth.scopedClientIds.length > 0 ? { clientId: { in: auth.scopedClientIds } } : {}),
      },
      select: { id: true },
    });

    const found = new Set(accounts.map((account) => account.id));
    const missing = accountIds.filter((id) => !found.has(id));

    if (missing.length > 0) {
      throw new ValidationError(
        'Algumas contas não existem nesta organização ou estão fora do seu acesso.',
        { contasInvalidas: missing },
      );
    }

    return accounts;
  }

  private toView(
    group: {
      id: string;
      name: string;
      description: string | null;
      color: string | null;
      createdAt: Date;
      members: Array<{
        socialAccount: {
          id: string;
          nickname: string;
          platform: PlatformKey;
          clientId: string;
          timezone: string;
          status: string;
          remoteDisplayName: string | null;
          remoteAvatarUrl: string | null;
          deletedAt: Date | null;
          client: { id: string; name: string };
        };
      }>;
    },
    auth: AuthContext,
  ): GroupView {
    const visible = group.members
      .map((member) => member.socialAccount)
      .filter((account) => account.deletedAt === null)
      .filter(
        (account) =>
          auth.scopedClientIds.length === 0 || auth.scopedClientIds.includes(account.clientId),
      );

    const countByPlatform: Record<string, number> = {};
    for (const account of visible) {
      countByPlatform[account.platform] = (countByPlatform[account.platform] ?? 0) + 1;
    }

    return {
      id: group.id,
      name: group.name,
      description: group.description,
      color: group.color,
      memberCount: visible.length,
      countByPlatform,
      members: visible.map((account) => ({
        accountId: account.id,
        nickname: account.nickname,
        platform: account.platform,
        platformName: getPlatformDefinition(account.platform).displayName,
        clientId: account.clientId,
        clientName: account.client.name,
        timezone: account.timezone,
        status: account.status,
        remoteDisplayName: account.remoteDisplayName,
        remoteAvatarUrl: account.remoteAvatarUrl,
      })),
      createdAt: group.createdAt.toISOString(),
    };
  }
}
