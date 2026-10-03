import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import {
  ConflictError,
  ForbiddenError,
  JOB_PROCESS_MEDIA,
  NotFoundError,
  ValidationError,
  mediaJobId,
} from '@app/core';
import type { MediaType } from '@app/db';
import { sha256Hex } from '@app/platform';
import type { Container } from '../../container.js';
import { recordAudit } from '../../lib/audit.js';
import { buildMediaKey } from '../../lib/storage.js';
import type { AuthContext } from '../../plugins/auth.js';

/**
 * Biblioteca de mídia (SPEC seção 6).
 *
 * Decisões de segurança que a SPEC seção 10 exige ("validação e limite de
 * upload, controle de MIME type"):
 *
 *  - o MIME declarado pelo cliente NÃO é confiável: conferimos a assinatura
 *    dos primeiros bytes do arquivo e recusamos quando não bate;
 *  - o tamanho é limitado no Fastify (antes de chegar aqui) e conferido de
 *    novo ao gravar;
 *  - o nome de arquivo é sanitizado antes de virar chave no bucket, para não
 *    permitir travessia de caminho;
 *  - a chave sempre começa com `org/<id>/`, o que torna possível apagar tudo
 *    de um tenant na exclusão da LGPD.
 */

/** Assinaturas ("magic numbers") dos formatos que aceitamos. */
const SIGNATURES: Array<{ mime: string; type: MediaType; test: (buf: Buffer) => boolean }> = [
  { mime: 'image/jpeg', type: 'IMAGE', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: 'image/png',
    type: 'IMAGE',
    test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  { mime: 'image/gif', type: 'IMAGE', test: (b) => b.subarray(0, 3).toString('ascii') === 'GIF' },
  {
    mime: 'image/webp',
    type: 'IMAGE',
    test: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP',
  },
  {
    mime: 'video/mp4',
    type: 'VIDEO',
    // O box 'ftyp' fica no offset 4 em MP4/MOV/3GP.
    test: (b) => b.subarray(4, 8).toString('ascii') === 'ftyp',
  },
  {
    mime: 'video/webm',
    type: 'VIDEO',
    test: (b) => b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])),
  },
  {
    mime: 'video/x-msvideo',
    type: 'VIDEO',
    test: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'AVI ',
  },
];

/**
 * Distingue os contêineres que compartilham o box `ftyp`. Um .mov enviado
 * como video/mp4 quebraria no upload para o YouTube, não aqui.
 */
function refineFtypBrand(buffer: Buffer): string {
  const brand = buffer.subarray(8, 12).toString('ascii');
  if (brand.startsWith('qt')) return 'video/quicktime';
  if (brand.startsWith('3g')) return 'video/3gpp';
  return 'video/mp4';
}

export interface DetectedType {
  mimeType: string;
  type: MediaType;
}

export function detectMediaType(head: Buffer, declaredMime: string): DetectedType {
  for (const signature of SIGNATURES) {
    if (!signature.test(head)) continue;

    const mimeType = signature.mime === 'video/mp4' ? refineFtypBrand(head) : signature.mime;
    return { mimeType, type: signature.type };
  }

  throw new ValidationError(
    `Não foi possível reconhecer o formato do arquivo. O tipo declarado foi "${declaredMime}", ` +
      `mas o conteúdo não corresponde a nenhum formato aceito ` +
      `(JPEG, PNG, GIF, WebP, MP4, MOV, 3GP, WebM, AVI).`,
  );
}

export interface UploadInput {
  filename: string;
  declaredMimeType: string;
  /** Buffer completo do arquivo. */
  data: Buffer;
  clientId?: string;
  folderId?: string;
  tags?: string[];
  /** Quando presente, grava como nova versão do asset informado. */
  replacesAssetId?: string;
}

export class MediaService {
  constructor(private readonly container: Container) {}

  async upload(
    auth: AuthContext,
    input: UploadInput,
    correlationId: string,
  ): Promise<{ id: string; deduplicated: boolean }> {
    if (input.data.length === 0) {
      throw new ValidationError('O arquivo enviado está vazio.');
    }
    if (input.data.length > this.container.env.MEDIA_MAX_UPLOAD_BYTES) {
      throw new ValidationError(
        `O arquivo tem ${formatBytes(input.data.length)} e o limite é ` +
          `${formatBytes(this.container.env.MEDIA_MAX_UPLOAD_BYTES)}.`,
      );
    }

    const detected = detectMediaType(input.data.subarray(0, 32), input.declaredMimeType);
    const checksum = sha256Hex(input.data);

    await this.assertStorageLimit(auth.organizationId, input.data.length);

    if (input.clientId) await this.assertClientScope(auth, input.clientId);

    // Deduplicação: o mesmo arquivo enviado duas vezes vira um registro só.
    // Além de economizar storage, é o que permite detectar depois que duas
    // contas receberiam mídia idêntica (SPEC seção 6.1).
    if (!input.replacesAssetId) {
      const existing = await this.container.prisma.mediaAsset.findFirst({
        where: { organizationId: auth.organizationId, checksum, deletedAt: null },
        select: { id: true },
      });
      if (existing) return { id: existing.id, deduplicated: true };
    }

    const assetId = randomUUID();
    const safeFilename = sanitizeFilename(input.filename);
    const storageKey = buildMediaKey(auth.organizationId, assetId, safeFilename);

    await this.container.storage.putObject({
      key: storageKey,
      body: input.data,
      contentType: detected.mimeType,
      contentLength: input.data.length,
      metadata: { organizationId: auth.organizationId, assetId },
    });

    let version = 1;
    if (input.replacesAssetId) {
      const parent = await this.container.prisma.mediaAsset.findFirst({
        where: {
          id: input.replacesAssetId,
          organizationId: auth.organizationId,
          deletedAt: null,
        },
        select: { version: true },
      });
      if (!parent) throw new NotFoundError('Arquivo', input.replacesAssetId);
      version = parent.version + 1;
    }

    const asset = await this.container.prisma.mediaAsset.create({
      data: {
        id: assetId,
        organizationId: auth.organizationId,
        clientId: input.clientId ?? null,
        folderId: input.folderId ?? null,
        uploadedById: auth.userId,
        filename: safeFilename,
        originalFilename: input.filename.slice(0, 255),
        mimeType: detected.mimeType,
        type: detected.type,
        sizeBytes: BigInt(input.data.length),
        storageKey,
        checksum,
        tags: input.tags ?? [],
        processingStatus: 'PENDING',
        ...(input.replacesAssetId ? { parentAssetId: input.replacesAssetId, version } : {}),
      },
    });

    // O worker extrai duração, resolução e thumbnail. É assíncrono porque
    // FFmpeg é CPU-bound e não pode segurar o p95 de 300ms da API.
    await this.container.queues.mediaProcessing.add(
      JOB_PROCESS_MEDIA,
      { mediaAssetId: asset.id, organizationId: auth.organizationId, correlationId },
      { jobId: mediaJobId(asset.id), attempts: 3, backoff: { type: 'exponential', delay: 10_000 } },
    );

    await recordAudit(this.container.prisma, {
      organizationId: auth.organizationId,
      actorUserId: auth.userId,
      action: 'media.upload',
      entityType: 'MediaAsset',
      entityId: asset.id,
      changes: { filename: safeFilename, mimeType: detected.mimeType, bytes: input.data.length },
      correlationId,
    });

    return { id: asset.id, deduplicated: false };
  }

  async list(
    auth: AuthContext,
    filters: {
      folderId?: string | null;
      clientId?: string;
      type?: MediaType;
      tag?: string;
      search?: string;
      limit: number;
      offset: number;
    },
  ): Promise<{ assets: MediaView[]; total: number }> {
    const where = {
      organizationId: auth.organizationId,
      deletedAt: null,
      ...(filters.folderId !== undefined ? { folderId: filters.folderId } : {}),
      ...(filters.clientId ? { clientId: filters.clientId } : {}),
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.tag ? { tags: { has: filters.tag } } : {}),
      ...(filters.search
        ? { originalFilename: { contains: filters.search, mode: 'insensitive' as const } }
        : {}),
      ...(auth.scopedClientIds.length > 0
        ? { OR: [{ clientId: { in: auth.scopedClientIds } }, { clientId: null }] }
        : {}),
    };

    const [assets, total] = await Promise.all([
      this.container.prisma.mediaAsset.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: filters.limit,
        skip: filters.offset,
      }),
      this.container.prisma.mediaAsset.count({ where }),
    ]);

    return {
      assets: await Promise.all(assets.map((asset) => this.toView(asset))),
      total,
    };
  }

  async get(auth: AuthContext, assetId: string): Promise<MediaView> {
    const asset = await this.container.prisma.mediaAsset.findFirst({
      where: { id: assetId, organizationId: auth.organizationId, deletedAt: null },
    });
    if (!asset) throw new NotFoundError('Arquivo', assetId);
    return this.toView(asset);
  }

  async update(
    auth: AuthContext,
    assetId: string,
    data: { tags?: string[]; folderId?: string | null; clientId?: string | null },
    correlationId: string,
  ): Promise<MediaView> {
    const asset = await this.container.prisma.mediaAsset.findFirst({
      where: { id: assetId, organizationId: auth.organizationId, deletedAt: null },
    });
    if (!asset) throw new NotFoundError('Arquivo', assetId);

    await this.container.prisma.mediaAsset.update({
      where: { id: assetId },
      data: {
        ...(data.tags ? { tags: data.tags } : {}),
        ...(data.folderId !== undefined ? { folderId: data.folderId } : {}),
        ...(data.clientId !== undefined ? { clientId: data.clientId } : {}),
      },
    });

    await recordAudit(this.container.prisma, {
      organizationId: auth.organizationId,
      actorUserId: auth.userId,
      action: 'media.update',
      entityType: 'MediaAsset',
      entityId: assetId,
      changes: data,
      correlationId,
    });

    return this.get(auth, assetId);
  }

  async remove(auth: AuthContext, assetId: string, correlationId: string): Promise<void> {
    const asset = await this.container.prisma.mediaAsset.findFirst({
      where: { id: assetId, organizationId: auth.organizationId, deletedAt: null },
      include: {
        contentMedia: {
          include: {
            content: {
              select: {
                id: true,
                title: true,
                posts: {
                  where: {
                    deletedAt: null,
                    targets: {
                      some: {
                        status: { in: ['PENDING', 'SCHEDULED', 'QUEUED', 'PUBLISHING', 'PROCESSING'] },
                        deletedAt: null,
                      },
                    },
                  },
                  select: { id: true },
                },
              },
            },
          },
        },
      },
    });
    if (!asset) throw new NotFoundError('Arquivo', assetId);

    // Recusamos apagar mídia que ainda vai ser publicada: o job só descobriria
    // o arquivo faltando na hora de subir, e o destino falharia sem motivo
    // aparente.
    const pending = asset.contentMedia.flatMap((link) => link.content.posts);
    if (pending.length > 0) {
      throw new ConflictError(
        `Este arquivo está em ${pending.length} publicação(ões) ainda não publicada(s). ` +
          `Remova-o dessas publicações antes de excluí-lo.`,
      );
    }

    // Soft-delete no banco. O objeto no bucket é removido pelo job de
    // retenção, depois da janela definida pela organização (SPEC seção 11).
    await this.container.prisma.mediaAsset.update({
      where: { id: assetId },
      data: { deletedAt: new Date() },
    });

    await recordAudit(this.container.prisma, {
      organizationId: auth.organizationId,
      actorUserId: auth.userId,
      action: 'media.delete',
      entityType: 'MediaAsset',
      entityId: assetId,
      changes: { filename: asset.filename },
      correlationId,
    });
  }

  // -------------------------------------------------------------------------
  //  Pastas
  // -------------------------------------------------------------------------

  async createFolder(
    auth: AuthContext,
    input: { name: string; parentId?: string },
    correlationId: string,
  ): Promise<{ id: string; name: string; path: string; parentId: string | null }> {
    const name = input.name.trim();
    if (name.includes('/')) {
      throw new ValidationError('O nome da pasta não pode conter barras.');
    }

    let path = `/${name}`;
    if (input.parentId) {
      const parent = await this.container.prisma.mediaFolder.findFirst({
        where: { id: input.parentId, organizationId: auth.organizationId, deletedAt: null },
        select: { path: true },
      });
      if (!parent) throw new NotFoundError('Pasta', input.parentId);
      path = `${parent.path}/${name}`;
    }

    const existing = await this.container.prisma.mediaFolder.findUnique({
      where: { organizationId_path: { organizationId: auth.organizationId, path } },
    });
    if (existing) throw new ConflictError(`Já existe uma pasta em ${path}.`);

    const folder = await this.container.prisma.mediaFolder.create({
      data: {
        organizationId: auth.organizationId,
        parentId: input.parentId ?? null,
        name,
        path,
      },
    });

    await recordAudit(this.container.prisma, {
      organizationId: auth.organizationId,
      actorUserId: auth.userId,
      action: 'media.folder_create',
      entityType: 'MediaFolder',
      entityId: folder.id,
      changes: { path },
      correlationId,
    });

    return { id: folder.id, name: folder.name, path: folder.path, parentId: folder.parentId };
  }

  async listFolders(
    auth: AuthContext,
  ): Promise<Array<{ id: string; name: string; path: string; parentId: string | null; assetCount: number }>> {
    const folders = await this.container.prisma.mediaFolder.findMany({
      where: { organizationId: auth.organizationId, deletedAt: null },
      include: { _count: { select: { assets: { where: { deletedAt: null } } } } },
      orderBy: { path: 'asc' },
    });

    return folders.map((folder) => ({
      id: folder.id,
      name: folder.name,
      path: folder.path,
      parentId: folder.parentId,
      assetCount: folder._count.assets,
    }));
  }

  // -------------------------------------------------------------------------

  private async assertStorageLimit(organizationId: string, incomingBytes: number): Promise<void> {
    const subscription = await this.container.prisma.subscription.findUnique({
      where: { organizationId },
      include: { plan: true },
    });
    if (!subscription) return;

    const limits = {
      ...(subscription.plan.limits as Record<string, unknown>),
      ...((subscription.limitOverrides as Record<string, unknown> | null) ?? {}),
    };
    const max = limits['maxStorageBytes'];
    if (typeof max !== 'number' || max < 0) return;

    const aggregate = await this.container.prisma.mediaAsset.aggregate({
      where: { organizationId, deletedAt: null },
      _sum: { sizeBytes: true },
    });

    const used = Number(aggregate._sum.sizeBytes ?? 0n);
    if (used + incomingBytes > max) {
      throw new ForbiddenError(
        `O armazenamento do plano ${subscription.plan.name} (${formatBytes(max)}) seria ` +
          `excedido. Em uso: ${formatBytes(used)}.`,
      );
    }
  }

  private async assertClientScope(auth: AuthContext, clientId: string): Promise<void> {
    if (auth.scopedClientIds.length > 0 && !auth.scopedClientIds.includes(clientId)) {
      throw new ForbiddenError('Seu acesso está limitado a outros clientes desta organização.');
    }
    const client = await this.container.prisma.client.findFirst({
      where: { id: clientId, organizationId: auth.organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!client) throw new NotFoundError('Cliente', clientId);
  }

  private async toView(asset: {
    id: string;
    filename: string;
    originalFilename: string;
    mimeType: string;
    type: MediaType;
    sizeBytes: bigint;
    storageKey: string;
    thumbnailKey: string | null;
    width: number | null;
    height: number | null;
    durationMs: number | null;
    processingStatus: string;
    processingError: string | null;
    tags: string[];
    folderId: string | null;
    clientId: string | null;
    version: number;
    createdAt: Date;
  }): Promise<MediaView> {
    return {
      id: asset.id,
      filename: asset.filename,
      originalFilename: asset.originalFilename,
      mimeType: asset.mimeType,
      type: asset.type,
      sizeBytes: Number(asset.sizeBytes),
      width: asset.width,
      height: asset.height,
      durationMs: asset.durationMs,
      processingStatus: asset.processingStatus,
      processingError: asset.processingError,
      tags: asset.tags,
      folderId: asset.folderId,
      clientId: asset.clientId,
      version: asset.version,
      createdAt: asset.createdAt.toISOString(),
      // URL assinada e temporária. Nenhuma URL de mídia é persistida —
      // o bucket é privado e o link expira.
      url: await this.container.storage.getSignedDownloadUrl(asset.storageKey, 900),
      thumbnailUrl: asset.thumbnailKey
        ? await this.container.storage.getSignedDownloadUrl(asset.thumbnailKey, 900)
        : null,
    };
  }
}

export interface MediaView {
  id: string;
  filename: string;
  originalFilename: string;
  mimeType: string;
  type: MediaType;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  processingStatus: string;
  processingError: string | null;
  tags: string[];
  folderId: string | null;
  clientId: string | null;
  version: number;
  createdAt: string;
  url: string;
  thumbnailUrl: string | null;
}

/**
 * Remove caminho e caracteres perigosos. Um nome como `../../etc/passwd`
 * viraria travessia de caminho na chave do bucket.
 */
function sanitizeFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? 'arquivo';
  return base.replace(/[^\w.\- ]/g, '_').slice(0, 180) || 'arquivo';
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

export { pipeline };
