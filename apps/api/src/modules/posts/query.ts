import { NotFoundError, formatInTimezone, getPlatformDefinition, type PlatformKey } from '@app/core';
import type { Container } from '../../container.js';
import type { AuthContext } from '../../plugins/auth.js';

/**
 * Consultas do calendário e da fila de publicação (SPEC seção 7).
 *
 * As duas telas leem daqui porque precisam da mesma informação: o post e o
 * estado de CADA destino. Uma lista que mostrasse só o status agregado
 * esconderia exatamente o que o usuário precisa ver — quais contas falharam.
 */

export interface TargetView {
  id: string;
  accountId: string;
  accountNickname: string;
  remoteDisplayName: string | null;
  platform: PlatformKey;
  platformName: string;
  status: string;
  scheduledAt: string | null;
  scheduledAtLocal: string | null;
  timezone: string;
  attempts: number;
  maxAttempts: number;
  remoteId: string | null;
  remoteUrl: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  errorPermanent: boolean;
  publishedAt: string | null;
  issues: Array<{ code: string; severity: string; message: string }>;
}

export interface PostListItem {
  id: string;
  status: string;
  scheduleMode: string;
  intendedScheduledAt: string | null;
  createdAt: string;
  publishedAt: string | null;
  clientId: string | null;
  clientName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  sourceGroupIds: string[];
  content: {
    id: string;
    title: string | null;
    body: string;
    mediaCount: number;
    firstMediaType: string | null;
  };
  targets: TargetView[];
  counts: {
    total: number;
    published: number;
    failed: number;
    pending: number;
    cancelled: number;
  };
}

export class PostQueryService {
  constructor(private readonly container: Container) {}

  async list(
    auth: AuthContext,
    filters: {
      from?: Date;
      to?: Date;
      status?: string[];
      groupId?: string;
      accountId?: string;
      clientId?: string;
      campaignId?: string;
      platform?: PlatformKey;
      limit: number;
      offset: number;
    },
  ): Promise<{ posts: PostListItem[]; total: number }> {
    // O filtro por grupo/conta é aplicado sobre os DESTINOS, não sobre o post:
    // um post para 20 contas aparece quando qualquer uma delas casa o filtro.
    const targetFilter = {
      deletedAt: null,
      ...(filters.accountId ? { socialAccountId: filters.accountId } : {}),
      ...(filters.platform ? { platform: filters.platform } : {}),
      ...(filters.groupId
        ? {
            socialAccount: {
              groupMemberships: { some: { accountGroupId: filters.groupId } },
            },
          }
        : {}),
      ...(filters.from || filters.to
        ? {
            scheduledAt: {
              ...(filters.from ? { gte: filters.from } : {}),
              ...(filters.to ? { lte: filters.to } : {}),
            },
          }
        : {}),
    };

    const where = {
      organizationId: auth.organizationId,
      deletedAt: null,
      ...(filters.status?.length ? { status: { in: filters.status as never[] } } : {}),
      ...(filters.clientId ? { clientId: filters.clientId } : {}),
      ...(filters.campaignId ? { campaignId: filters.campaignId } : {}),
      ...(auth.scopedClientIds.length > 0
        ? { OR: [{ clientId: { in: auth.scopedClientIds } }, { clientId: null }] }
        : {}),
      targets: { some: targetFilter },
    };

    const [posts, total] = await Promise.all([
      this.container.prisma.post.findMany({
        where,
        include: this.include(),
        orderBy: [{ intendedScheduledAt: 'asc' }, { createdAt: 'desc' }],
        take: filters.limit,
        skip: filters.offset,
      }),
      this.container.prisma.post.count({ where }),
    ]);

    return { posts: posts.map((post) => this.toListItem(post)), total };
  }

  async get(auth: AuthContext, postId: string): Promise<PostListItem> {
    const post = await this.container.prisma.post.findFirst({
      where: { id: postId, organizationId: auth.organizationId, deletedAt: null },
      include: this.include(),
    });

    if (!post) throw new NotFoundError('Publicação', postId);
    return this.toListItem(post);
  }

  /** Resumo do dashboard: contas conectadas, publicados, agendados, com erro. */
  async dashboard(auth: AuthContext): Promise<{
    accounts: { total: number; needingReconnect: number; byPlatform: Record<string, number> };
    posts: { published7d: number; scheduled: number; failed: number; awaitingApproval: number };
    queue: { nextPublications: Array<{ postId: string; accountNickname: string; scheduledAtLocal: string }> };
  }> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60_000);

    const [accounts, published7d, scheduled, failed, awaitingApproval, upcoming] =
      await Promise.all([
        this.container.prisma.socialAccount.findMany({
          where: { organizationId: auth.organizationId, deletedAt: null },
          select: { platform: true, status: true },
        }),
        this.container.prisma.postTarget.count({
          where: {
            organizationId: auth.organizationId,
            status: 'PUBLISHED',
            publishedAt: { gte: sevenDaysAgo },
            deletedAt: null,
          },
        }),
        this.container.prisma.postTarget.count({
          where: {
            organizationId: auth.organizationId,
            status: { in: ['SCHEDULED', 'QUEUED'] },
            deletedAt: null,
          },
        }),
        this.container.prisma.postTarget.count({
          where: { organizationId: auth.organizationId, status: 'FAILED', deletedAt: null },
        }),
        this.container.prisma.approval.count({
          where: { organizationId: auth.organizationId, status: 'PENDING' },
        }),
        this.container.prisma.postTarget.findMany({
          where: {
            organizationId: auth.organizationId,
            status: { in: ['SCHEDULED', 'QUEUED'] },
            scheduledAt: { gte: new Date() },
            deletedAt: null,
          },
          include: { socialAccount: { select: { nickname: true, timezone: true } } },
          orderBy: { scheduledAt: 'asc' },
          take: 10,
        }),
      ]);

    const byPlatform: Record<string, number> = {};
    for (const account of accounts) {
      byPlatform[account.platform] = (byPlatform[account.platform] ?? 0) + 1;
    }

    return {
      accounts: {
        total: accounts.length,
        needingReconnect: accounts.filter((a) => a.status === 'NEEDS_RECONNECT').length,
        byPlatform,
      },
      posts: { published7d, scheduled, failed, awaitingApproval },
      queue: {
        nextPublications: upcoming.map((target) => ({
          postId: target.postId,
          accountNickname: target.socialAccount.nickname,
          scheduledAtLocal: target.scheduledAt
            ? formatInTimezone(target.scheduledAt, target.socialAccount.timezone).full
            : '—',
        })),
      },
    };
  }

  // -------------------------------------------------------------------------

  private include() {
    return {
      client: { select: { id: true, name: true } },
      campaign: { select: { id: true, name: true } },
      content: {
        select: {
          id: true,
          title: true,
          body: true,
          media: {
            select: { mediaAsset: { select: { type: true } } },
            orderBy: { position: 'asc' as const },
          },
        },
      },
      targets: {
        where: { deletedAt: null },
        include: {
          socialAccount: {
            select: { id: true, nickname: true, timezone: true, remoteDisplayName: true },
          },
        },
        orderBy: [{ platform: 'asc' as const }, { scheduledAt: 'asc' as const }],
      },
    };
  }

  private toListItem(post: {
    id: string;
    status: string;
    scheduleMode: string;
    intendedScheduledAt: Date | null;
    createdAt: Date;
    publishedAt: Date | null;
    clientId: string | null;
    campaignId: string | null;
    sourceGroupIds: string[];
    client: { id: string; name: string } | null;
    campaign: { id: string; name: string } | null;
    content: {
      id: string;
      title: string | null;
      body: string;
      media: Array<{ mediaAsset: { type: string } }>;
    };
    targets: Array<{
      id: string;
      socialAccountId: string;
      platform: PlatformKey;
      status: string;
      scheduledAt: Date | null;
      scheduledTimezone: string | null;
      attempts: number;
      maxAttempts: number;
      remoteId: string | null;
      remoteUrl: string | null;
      errorCode: string | null;
      errorMessage: string | null;
      errorPermanent: boolean;
      publishedAt: Date | null;
      validationIssues: unknown;
      socialAccount: {
        id: string;
        nickname: string;
        timezone: string;
        remoteDisplayName: string | null;
      };
    }>;
  }): PostListItem {
    const targets: TargetView[] = post.targets.map((target) => {
      const timezone = target.scheduledTimezone ?? target.socialAccount.timezone;

      return {
        id: target.id,
        accountId: target.socialAccountId,
        accountNickname: target.socialAccount.nickname,
        remoteDisplayName: target.socialAccount.remoteDisplayName,
        platform: target.platform,
        platformName: getPlatformDefinition(target.platform).displayName,
        status: target.status,
        scheduledAt: target.scheduledAt?.toISOString() ?? null,
        // Sempre exibido no fuso da CONTA, com o fuso explícito junto —
        // sem isso, "10:00" numa lista com contas de fusos diferentes engana.
        scheduledAtLocal: target.scheduledAt
          ? formatInTimezone(target.scheduledAt, timezone).full
          : null,
        timezone,
        attempts: target.attempts,
        maxAttempts: target.maxAttempts,
        remoteId: target.remoteId,
        remoteUrl: target.remoteUrl,
        errorCode: target.errorCode,
        errorMessage: target.errorMessage,
        errorPermanent: target.errorPermanent,
        publishedAt: target.publishedAt?.toISOString() ?? null,
        issues: Array.isArray(target.validationIssues)
          ? (target.validationIssues as Array<{ code: string; severity: string; message: string }>)
          : [],
      };
    });

    return {
      id: post.id,
      status: post.status,
      scheduleMode: post.scheduleMode,
      intendedScheduledAt: post.intendedScheduledAt?.toISOString() ?? null,
      createdAt: post.createdAt.toISOString(),
      publishedAt: post.publishedAt?.toISOString() ?? null,
      clientId: post.clientId,
      clientName: post.client?.name ?? null,
      campaignId: post.campaignId,
      campaignName: post.campaign?.name ?? null,
      sourceGroupIds: post.sourceGroupIds,
      content: {
        id: post.content.id,
        title: post.content.title,
        body: post.content.body.slice(0, 500),
        mediaCount: post.content.media.length,
        firstMediaType: post.content.media[0]?.mediaAsset.type ?? null,
      },
      targets,
      counts: {
        total: targets.length,
        published: targets.filter((t) => t.status === 'PUBLISHED').length,
        failed: targets.filter((t) => t.status === 'FAILED').length,
        pending: targets.filter((t) => ['PENDING', 'SCHEDULED', 'QUEUED', 'PUBLISHING'].includes(t.status)).length,
        cancelled: targets.filter((t) => t.status === 'CANCELLED').length,
      },
    };
  }
}
