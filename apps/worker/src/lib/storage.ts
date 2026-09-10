import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';

/**
 * Acesso ao storage pelo worker.
 *
 * Menor superfície que a interface da API de propósito: o worker só precisa
 * ler o arquivo para publicar e gravar a miniatura gerada. Não expõe
 * `deleteObject` — expurgo é responsabilidade do job de retenção, que passa
 * pelo caminho auditado.
 */

export interface Storage {
  getObjectStream(key: string): Promise<Readable>;
  getObjectBuffer(key: string): Promise<Buffer>;
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
}

export interface S3Config {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle: boolean;
}

export class S3Storage implements Storage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: S3Config) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      // Vídeo grande demora; o timeout aqui é maior que o da API, mas existe.
      requestHandler: { requestTimeout: 600_000, connectionTimeout: 10_000 },
    });
  }

  async getObjectStream(key: string): Promise<Readable> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!response.Body) throw new Error(`Objeto não encontrado no storage: ${key}`);
    return response.Body as Readable;
  }

  async getObjectBuffer(key: string): Promise<Buffer> {
    const stream = await this.getObjectStream(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    return Buffer.concat(chunks);
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.length,
      }),
    );
  }
}
