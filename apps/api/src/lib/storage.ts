import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';

/**
 * Interface `StorageProvider` da SPEC seção 9.
 *
 * O resto do sistema nunca fala com S3 diretamente — troca de MinIO (dev)
 * para S3/R2 (produção) é configuração, não mudança de código.
 *
 * Nenhuma URL de mídia é persistida no banco: guardamos a CHAVE e assinamos
 * uma URL temporária na hora de exibir. URL permanente em bucket privado
 * viraria link público por acidente no primeiro relatório exportado.
 */

export interface StorageProvider {
  putObject(input: PutObjectInput): Promise<void>;
  getObjectStream(key: string): Promise<Readable>;
  getSignedDownloadUrl(key: string, expiresInSeconds?: number): Promise<string>;
  getSignedUploadUrl(key: string, contentType: string, expiresInSeconds?: number): Promise<string>;
  deleteObject(key: string): Promise<void>;
  objectExists(key: string): Promise<boolean>;
  headObject(key: string): Promise<{ sizeBytes: number; contentType?: string } | null>;
}

export interface PutObjectInput {
  key: string;
  body: Buffer | Readable;
  contentType: string;
  contentLength?: number;
  metadata?: Record<string, string>;
}

export interface S3StorageConfig {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle: boolean;
}

export class S3StorageProvider implements StorageProvider {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: S3StorageConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      // Timeout explícito: sem isto, um MinIO travado segura o request da API
      // até o timeout do Node (SPEC seção 12).
      requestHandler: { requestTimeout: 30_000, connectionTimeout: 5_000 },
    });
  }

  async putObject(input: PutObjectInput): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        ...(input.contentLength !== undefined ? { ContentLength: input.contentLength } : {}),
        ...(input.metadata ? { Metadata: input.metadata } : {}),
      }),
    );
  }

  async getObjectStream(key: string): Promise<Readable> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!response.Body) throw new Error(`Objeto vazio ou inexistente: ${key}`);
    return response.Body as Readable;
  }

  async getSignedDownloadUrl(key: string, expiresInSeconds = 900): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }

  async getSignedUploadUrl(
    key: string,
    contentType: string,
    expiresInSeconds = 900,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      { expiresIn: expiresInSeconds },
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async objectExists(key: string): Promise<boolean> {
    return (await this.headObject(key)) !== null;
  }

  async headObject(key: string): Promise<{ sizeBytes: number; contentType?: string } | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        sizeBytes: response.ContentLength ?? 0,
        ...(response.ContentType ? { contentType: response.ContentType } : {}),
      };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw error;
    }
  }
}

/**
 * Caminho no bucket. Prefixar por organização é o que torna possível apagar
 * tudo de um tenant no direito de exclusão da LGPD (SPEC seção 11) sem
 * varrer o bucket inteiro.
 */
export function buildMediaKey(
  organizationId: string,
  mediaAssetId: string,
  filename: string,
): string {
  const safeName = filename.replace(/[^\w.-]/g, '_').slice(-120);
  return `org/${organizationId}/media/${mediaAssetId}/${safeName}`;
}

export function buildThumbnailKey(organizationId: string, mediaAssetId: string): string {
  return `org/${organizationId}/media/${mediaAssetId}/thumb.jpg`;
}

export function buildReportKey(organizationId: string, reportId: string, format: string): string {
  return `org/${organizationId}/reports/${reportId}.${format.toLowerCase()}`;
}
