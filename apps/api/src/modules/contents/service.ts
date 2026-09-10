import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  getPlatformDefinition,
  resolveVariantFor,
  type PlatformKey,
} from '@app/core';
import type { Container } from '../../container.js';
import { recordAudit } from '../../lib/audit.js';
import type { AuthContext } from '../../plugins/auth.js';

/**
 * Conteúdo mestre e suas variações (SPEC seção 6, "compositor de conteúdo").
 *
 * Modelo em três camadas, e a terceira é a que costuma faltar nas ferramentas:
 *
 *   Content         — o texto base e a mídia, sem destino
 *   ContentVariant  — variação por PLATAFORMA (legenda/título/hashtags)
 *   ContentVariant  — override por CONTA (ex.: legenda diferente só no TikTok 3)
 *
 * A distinção entre os dois últimos é o campo `socialAccountId`: nulo = vale
 * para a plataforma inteira; preenchido = override daquela conta.
 */

export interface VariantInput {
  platform: PlatformKey;
  /** Nulo = variação da plataforma. Preenchido = override desta conta. */
  socialAccountId?: string | null;
  title?: string | null;
  body?: string | null;
  hashtags?: string[];
  /** Campos obrigatórios da rede (privacidade, categoria, consentimento...). */
  platformFields?: Record<string, unknown>;
}

export interface ContentView {
  id: string;
  title: string | null;
  body: string;
  hashtags: string[];
  aiGenerated: boolean;
  aiReviewedAt: string | null;
  clientId: string | null;
  campaignId: string | null;
  createdAt: string;
  updatedAt: string;
  media: Array<{
    mediaAssetId: string;
    position: number;
    role: string;
    filename: string;
    type: string;
    mimeType: string;
    processingStatus: string;
    durationMs: number | null;
    width: number | null;
    height: number | null;
  }>;
  variants: Array<{
    id: string;
    platform: PlatformKey;
    socialAccountId: string | null;
    accountNickname: string | null;
    title: string | null;
    body: string | null;
    hashtags: string[];
    platformFields: Record<string, unknown>;
  }>;
}

// Re-exportado para os módulos que já importavam daqui; a implementação
// mora em @app/core para API e worker resolverem a cascata igual.
export { resolveVariantFor };

export class ContentService {
  constructor(private readonly container: Container) {}

  async create(
    auth: AuthContext,
    input: {
      title?: string;
      body?: string;
      hashtags?: string[];
      clientId?: string;
      campaignId?: string;
      mediaAssetIds?: string[];
      aiGenerated?: boolean;
    },
    correlationId: string,
  ): Promise<ContentView> {
    if (input.clientId) this.assertClientScope(auth, input.clientId);

    const mediaAssetIds = input.mediaAssetIds ?? [];
    if (mediaAssetIds.length > 0) await this.assertMediaExists(auth, mediaAssetIds);

    const content = await this.container.prisma.content.create({
      data: {
        organizationId: auth.organizationId,
        clientId: input.clientId ?? null,
        campaignId: input.campaignId ?? null,
        createdById: auth.userId,
        title: input.title ?? null,
        body: input.body ?? '',
        hashtags: input.hashtags ?? [],
        aiGenerated: input.aiGenerated ?? false,
        media: {
          create: mediaAssetIds.map((mediaAssetId, position) => ({
            mediaAssetId,
            position,
            role: 'MAIN',
          })),
        },
      },
    });

    await recordAudit(this.container.prisma, {
      organizationId: auth.organizationId,
      actorUserId: auth.userId,
      action: 'content.create',
      entityType: 'Content',
      entityId: content.id,
      changes: { title: content.title, midias: mediaAssetIds.length },
      correlationId,
    });

    return this.get(auth, content.id);
  }

  async update(
    auth: AuthContext,
    contentId: string,
    input: {
      title?: string | null;
      body?: string;
      hashtags?: string[];
      clientId?: string | null;
      campaignId?: string | null;
      mediaAssetIds?: string[];
    },
    correlationId: string,
  ): Promise<ContentView> {
    const content = await this.loadOwned(auth, contentId);

    if (input.clientId) this.assertClientScope(auth, input.clientId);
    if (input.mediaAssetIds) await this.assertMediaExists(auth, input.mediaAssetIds);

    await this.container.prisma.$transaction(async (tx) => {
      await tx.content.update({
        where: { id: content.id },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.hashtags ? { hashtags: input.hashtags } : {}),
          ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
          ...(input.campaignId !== undefined ? { campaignId: input.campaignId } : {}),
          // Editar conteúdo gerado por IA marca a revisão humana exigida pela
          // SPEC seção 6 antes de qualquer publicação.
          ...(content.aiGenerated && content.aiReviewedAt === null
            ? { aiReviewedAt: new Date() }
            : {}),
        },
      });

      if (input.mediaAssetIds) {
        await tx.contentMedia.deleteMany({ where: { contentId: content.id } });
        await tx.contentMedia.createMany({
          data: input.mediaAssetIds.map((mediaAssetId, position) => ({
            contentId: content.id,
            mediaAssetId,
            position,
            role: 'MAIN',
          })),
        });
      }
    });

    await recordAudit(this.container.prisma, {
      organizationId: auth.organizationId,
      actorUserId: auth.userId,
      action: 'content.update',
      entityType: 'Content',
      entityId: content.id,
      changes: input,
      correlationId,
    });

    return this.get(auth, contentId);
  }

  /**
   * Define as variações. Substitui o conjunto inteiro, para o resultado ser
   * previsível: o compositor manda o estado completo da tela.
   */
  async setVariants(
    auth: AuthContext,
    contentId: string,
    variants: VariantInput[],
    correlationId: string,
  ): Promise<ContentView> {
    await this.loadOwned(auth, contentId);

    // Overrides precisam apontar para contas reais da organização, senão
    // ficariam órfãos e nunca seriam aplicados.
    const accountIds = variants
      .map((variant) => variant.socialAccountId)
      .filter((id): id is string => typeof id === 'string');

    if (accountIds.length > 0) {
      const accounts = await this.container.prisma.socialAccount.findMany({
        where: {
          id: { in: accountIds },
          organizationId: auth.organizationId,
          deletedAt: null,
        },
        select: { id: true, platform: true },
      });

      const byId = new Map(accounts.map((account) => [account.id, account]));

      for (const variant of variants) {
        if (!variant.socialAccountId) continue;
        const account = byId.get(variant.socialAccountId);

        if (!account) {
          throw new ValidationError(
            `A conta ${variant.socialAccountId} não existe nesta organização.`,
          );
        }
        // Um override de conta declarado sob a plataforma errada nunca seria
        // encontrado na resolução da cascata — falha silenciosa clássica.
        if (account.platform !== variant.platform) {
          throw new ValidationError(
            `A conta informada é de ${getPlatformDefinition(account.platform).displayName}, ` +
              `mas a variação foi declarada para ${getPlatformDefinition(variant.platform).displayName}.`,
          );
        }
      }
    }

    await this.container.prisma.$transaction(async (tx) => {
      await tx.contentVariant.deleteMany({ where: { contentId } });

      for (const variant of variants) {
        await tx.contentVariant.create({
          data: {
            contentId,
            organizationId: auth.organizationId,
            platform: variant.platform,
            socialAccountId: variant.socialAccountId ?? null,
            title: variant.title ?? null,
            body: variant.body ?? null,
            hashtags: variant.hashtags ?? [],
            platformFields: (variant.platformFields ?? {}) as object,
          },
        });
      }
    });

    await recordAudit(this.container.prisma, {
      organizationId: auth.organizationId,
      actorUserId: auth.userId,
      action: 'content.variants_set',
      entityType: 'Content',
      entityId: contentId,
      changes: {
        variacoes: variants.length,
        overridesPorConta: accountIds.length,
      },
      correlationId,
    });

    return this.get(auth, contentId);
  }

  async get(auth: AuthContext, contentId: string): Promise<ContentView> {
    const content = await this.container.prisma.content.findFirst({
      where: { id: contentId, organizationId: auth.organizationId, deletedAt: null },
      include: {
        media: {
          include: { mediaAsset: true },
          orderBy: { position: 'asc' },
        },
        variants: {
          include: { socialAccount: { select: { nickname: true } } },
        },
      },
    });

    if (!content) throw new NotFoundError('Conteúdo', contentId);

    return {
      id: content.id,
      title: content.title,
      body: content.body,
      hashtags: content.hashtags,
      aiGenerated: content.aiGenerated,
      aiReviewedAt: content.aiReviewedAt?.toISOString() ?? null,
      clientId: content.clientId,
      campaignId: content.campaignId,
      createdAt: content.createdAt.toISOString(),
      updatedAt: content.updatedAt.toISOString(),
      media: content.media.map((link) => ({
        mediaAssetId: link.mediaAssetId,
        position: link.position,
        role: link.role,
        filename: link.mediaAsset.originalFilename,
        type: link.mediaAsset.type,
        mimeType: link.mediaAsset.mimeType,
        processingStatus: link.mediaAsset.processingStatus,
        durationMs: link.mediaAsset.durationMs,
        width: link.mediaAsset.width,
        height: link.mediaAsset.height,
      })),
      variants: content.variants.map((variant) => ({
        id: variant.id,
        platform: variant.platform,
        socialAccountId: variant.socialAccountId,
        accountNickname: variant.socialAccount?.nickname ?? null,
        title: variant.title,
        body: variant.body,
        hashtags: variant.hashtags,
        platformFields: (variant.platformFields as Record<string, unknown> | null) ?? {},
      })),
    };
  }

  async list(
    auth: AuthContext,
    filters: { clientId?: string; campaignId?: string; limit: number; offset: number },
  ): Promise<{ contents: ContentView[]; total: number }> {
    const where = {
      organizationId: auth.organizationId,
      deletedAt: null,
      ...(filters.clientId ? { clientId: filters.clientId } : {}),
      ...(filters.campaignId ? { campaignId: filters.campaignId } : {}),
      ...(auth.scopedClientIds.length > 0
        ? { OR: [{ clientId: { in: auth.scopedClientIds } }, { clientId: null }] }
        : {}),
    };

    const [ids, total] = await Promise.all([
      this.container.prisma.content.findMany({
        where,
        select: { id: true },
        orderBy: { updatedAt: 'desc' },
        take: filters.limit,
        skip: filters.offset,
      }),
      this.container.prisma.content.count({ where }),
    ]);

    const contents = await Promise.all(ids.map((row) => this.get(auth, row.id)));
    return { contents, total };
  }

  async remove(auth: AuthContext, contentId: string, correlationId: string): Promise<void> {
    const content = await this.loadOwned(auth, contentId);

    await this.container.prisma.content.update({
      where: { id: content.id },
      data: { deletedAt: new Date() },
    });

    await recordAudit(this.container.prisma, {
      organizationId: auth.organizationId,
      actorUserId: auth.userId,
      action: 'content.delete',
      entityType: 'Content',
      entityId: contentId,
      correlationId,
    });
  }

  // -------------------------------------------------------------------------

  private async loadOwned(
    auth: AuthContext,
    contentId: string,
  ): Promise<{ id: string; clientId: string | null; aiGenerated: boolean; aiReviewedAt: Date | null }> {
    const content = await this.container.prisma.content.findFirst({
      where: { id: contentId, organizationId: auth.organizationId, deletedAt: null },
      select: { id: true, clientId: true, aiGenerated: true, aiReviewedAt: true },
    });
    if (!content) throw new NotFoundError('Conteúdo', contentId);
    if (content.clientId) this.assertClientScope(auth, content.clientId);
    return content;
  }

  private assertClientScope(auth: AuthContext, clientId: string): void {
    if (auth.scopedClientIds.length > 0 && !auth.scopedClientIds.includes(clientId)) {
      throw new ForbiddenError('Seu acesso está limitado a outros clientes desta organização.');
    }
  }

  private async assertMediaExists(auth: AuthContext, mediaAssetIds: string[]): Promise<void> {
    const found = await this.container.prisma.mediaAsset.findMany({
      where: {
        id: { in: mediaAssetIds },
        organizationId: auth.organizationId,
        deletedAt: null,
      },
      select: { id: true },
    });

    const foundIds = new Set(found.map((asset) => asset.id));
    const missing = mediaAssetIds.filter((id) => !foundIds.has(id));

    if (missing.length > 0) {
      throw new ValidationError('Alguns arquivos não existem na biblioteca desta organização.', {
        arquivosInvalidos: missing,
      });
    }
  }
}
