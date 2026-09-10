import {
  ForbiddenError,
  NotFoundError,
  assertValidTimezone,
  getPlatformDefinition,
  type PlatformKey,
} from '@app/core';
import { revokeAndClear } from '@app/platform';
import type { Container } from '../../container.js';
import { adapterContext } from '../../lib/adapter-context.js';
import { recordAudit } from '../../lib/audit.js';
import type { AuthContext } from '../../plugins/auth.js';

/**
 * Contas conectadas (SPEC seções 6 e 6.1).
 *
 * A regra estrutural: N contas por rede por cliente. Nada aqui — nem consulta,
 * nem índice, nem validação — pode assumir "uma conta por rede", que é o
 * limite do Metricool que a especificação rejeita explicitamente.
 */

export interface AccountView {
  id: string;
  platform: PlatformKey;
  platformName: string;
  nickname: string;
  timezone: string;
  status: string;
  statusReason: string | null;
  remoteId: string;
  remoteUsername: string | null;
  remoteDisplayName: string | null;
  remoteAvatarUrl: string | null;
  remoteProfileUrl: string | null;
  isBusinessAccount: boolean;
  clientId: string;
  clientName: string;
  connectedAt: string;
  lastPublishedAt: string | null;
  /** Estado do token, sem NUNCA expor o token em si. */
  token: {
    expiresAt: string | null;
    scopes: string[];
    needsReconnect: boolean;
  };
  groups: Array<{ id: string; name: string }>;
  /** Grade semanal da fila, no fuso da conta. */
  queueSlots: Array<{ weekday: number; hour: number; minute: number }>;
}

export class AccountService {
  constructor(private readonly container: Container) {}

  async list(
    auth: AuthContext,
    filters: { platform?: PlatformKey; clientId?: string; groupId?: string } = {},
  ): Promise<AccountView[]> {
    const accounts = await this.container.prisma.socialAccount.findMany({
      where: {
        organizationId: auth.organizationId,
        deletedAt: null,
        ...(filters.platform ? { platform: filters.platform } : {}),
        ...(filters.clientId ? { clientId: filters.clientId } : {}),
        ...(filters.groupId
          ? { groupMemberships: { some: { accountGroupId: filters.groupId } } }
          : {}),
        // Membro com escopo por cliente só enxerga as contas dos seus clientes.
        ...(auth.scopedClientIds.length > 0
          ? { clientId: { in: auth.scopedClientIds } }
          : {}),
      },
      include: {
        client: { select: { id: true, name: true } },
        oauthToken: {
          select: { accessTokenExpiresAt: true, scopes: true, revokedAt: true },
        },
        postingSchedule: { select: { slots: true, isEnabled: true } },
        groupMemberships: {
          include: { accountGroup: { select: { id: true, name: true, deletedAt: true } } },
        },
      },
      orderBy: [{ platform: 'asc' }, { nickname: 'asc' }],
    });

    return accounts.map((account) => this.toView(account));
  }

  async get(auth: AuthContext, accountId: string): Promise<AccountView> {
    const account = await this.container.prisma.socialAccount.findFirst({
      where: { id: accountId, organizationId: auth.organizationId, deletedAt: null },
      include: {
        client: { select: { id: true, name: true } },
        oauthToken: {
          select: { accessTokenExpiresAt: true, scopes: true, revokedAt: true },
        },
        postingSchedule: { select: { slots: true, isEnabled: true } },
        groupMemberships: {
          include: { accountGroup: { select: { id: true, name: true, deletedAt: true } } },
        },
      },
    });

    if (!account) throw new NotFoundError('Conta conectada', accountId);
    this.assertClientScope(auth, account.clientId);

    return this.toView(account);
  }

  async update(
    auth: AuthContext,
    accountId: string,
    data: { nickname?: string; timezone?: string },
    correlationId: string,
  ): Promise<AccountView> {
    const account = await this.container.prisma.socialAccount.findFirst({
      where: { id: accountId, organizationId: auth.organizationId, deletedAt: null },
      select: { id: true, clientId: true, nickname: true, timezone: true },
    });
    if (!account) throw new NotFoundError('Conta conectada', accountId);
    this.assertClientScope(auth, account.clientId);

    if (data.timezone) assertValidTimezone(data.timezone);

    await this.container.prisma.socialAccount.update({
      where: { id: accountId },
      data: {
        ...(data.nickname ? { nickname: data.nickname.trim() } : {}),
        ...(data.timezone ? { timezone: data.timezone } : {}),
      },
    });

    await recordAudit(this.container.prisma, {
      organizationId: auth.organizationId,
      actorUserId: auth.userId,
      action: 'account.update',
      entityType: 'SocialAccount',
      entityId: accountId,
      changes: {
        antes: { nickname: account.nickname, timezone: account.timezone },
        depois: data,
      },
      correlationId,
    });

    return this.get(auth, accountId);
  }

  /**
   * Desconectar revoga o token na plataforma e marca a conta, mas NÃO apaga o
   * histórico: relatórios já emitidos e métricas passadas continuam válidos.
   * A remoção definitiva só acontece no fluxo de exclusão da LGPD.
   */
  async disconnect(
    auth: AuthContext,
    accountId: string,
    correlationId: string,
  ): Promise<{ revokedRemotely: boolean; scheduledTargetsCancelled: number }> {
    const account = await this.container.prisma.socialAccount.findFirst({
      where: { id: accountId, organizationId: auth.organizationId, deletedAt: null },
      select: { id: true, clientId: true, nickname: true, platform: true },
    });
    if (!account) throw new NotFoundError('Conta conectada', accountId);
    this.assertClientScope(auth, account.clientId);

    const ctx = adapterContext(this.container, correlationId, 20_000);

    const revocation = await revokeAndClear(
      {
        prisma: this.container.prisma,
        keyring: this.container.keyring,
        platforms: this.container.platforms,
      },
      accountId,
      ctx,
    );

    // Agendamentos futuros desta conta não podem ficar pendurados: sem token
    // eles falhariam um a um às 3h da manhã. Cancelamos de forma explícita e
    // informamos quantos foram — o usuário precisa saber o que perdeu.
    const cancelled = await this.container.prisma.postTarget.updateMany({
      where: {
        socialAccountId: accountId,
        status: { in: ['PENDING', 'SCHEDULED', 'QUEUED'] },
        deletedAt: null,
      },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        errorCode: 'ACCOUNT_DISCONNECTED',
        errorMessage: `A conta "${account.nickname}" foi desconectada antes da publicação.`,
      },
    });

    await this.container.prisma.socialAccount.update({
      where: { id: accountId },
      data: {
        status: 'DISCONNECTED',
        statusReason: 'Desconectada pelo usuário.',
      },
    });

    await recordAudit(this.container.prisma, {
      organizationId: auth.organizationId,
      actorUserId: auth.userId,
      action: 'account.disconnect',
      entityType: 'SocialAccount',
      entityId: accountId,
      changes: {
        platform: account.platform,
        revokedRemotely: revocation.revokedRemotely,
        agendamentosCancelados: cancelled.count,
      },
      correlationId,
    });

    return {
      revokedRemotely: revocation.revokedRemotely,
      scheduledTargetsCancelled: cancelled.count,
    };
  }

  private assertClientScope(auth: AuthContext, clientId: string): void {
    if (auth.scopedClientIds.length > 0 && !auth.scopedClientIds.includes(clientId)) {
      throw new ForbiddenError('Seu acesso está limitado a outros clientes desta organização.');
    }
  }

  private toView(account: {
    id: string;
    platform: PlatformKey;
    nickname: string;
    timezone: string;
    status: string;
    statusReason: string | null;
    remoteId: string;
    remoteUsername: string | null;
    remoteDisplayName: string | null;
    remoteAvatarUrl: string | null;
    remoteProfileUrl: string | null;
    isBusinessAccount: boolean;
    clientId: string;
    connectedAt: Date;
    lastPublishedAt: Date | null;
    client: { id: string; name: string };
    oauthToken: { accessTokenExpiresAt: Date | null; scopes: string[]; revokedAt: Date | null } | null;
    postingSchedule: { slots: unknown; isEnabled: boolean } | null;
    groupMemberships: Array<{ accountGroup: { id: string; name: string; deletedAt: Date | null } }>;
  }): AccountView {
    const slots = Array.isArray(account.postingSchedule?.slots)
      ? (account.postingSchedule.slots as Array<{ weekday: number; hour: number; minute: number }>)
      : [];

    return {
      id: account.id,
      platform: account.platform,
      platformName: getPlatformDefinition(account.platform).displayName,
      nickname: account.nickname,
      timezone: account.timezone,
      status: account.status,
      statusReason: account.statusReason,
      remoteId: account.remoteId,
      remoteUsername: account.remoteUsername,
      remoteDisplayName: account.remoteDisplayName,
      remoteAvatarUrl: account.remoteAvatarUrl,
      remoteProfileUrl: account.remoteProfileUrl,
      isBusinessAccount: account.isBusinessAccount,
      clientId: account.clientId,
      clientName: account.client.name,
      connectedAt: account.connectedAt.toISOString(),
      lastPublishedAt: account.lastPublishedAt?.toISOString() ?? null,
      token: {
        // Só a data de expiração e os escopos. O token cifrado nunca sai daqui.
        expiresAt: account.oauthToken?.accessTokenExpiresAt?.toISOString() ?? null,
        scopes: account.oauthToken?.scopes ?? [],
        needsReconnect:
          account.status === 'NEEDS_RECONNECT' ||
          account.oauthToken === null ||
          account.oauthToken.revokedAt !== null,
      },
      groups: account.groupMemberships
        .filter((membership) => membership.accountGroup.deletedAt === null)
        .map((membership) => ({
          id: membership.accountGroup.id,
          name: membership.accountGroup.name,
        })),
      queueSlots: account.postingSchedule?.isEnabled ? slots : [],
    };
  }
}
