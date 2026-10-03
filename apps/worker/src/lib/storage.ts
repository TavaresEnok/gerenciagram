import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';

/**
 * Acesso ao storage pelo worker.
 *
 * Menor superfície que a interface da API de propósito. `deleteObject` existe
 * para o expurgo (retenção e direito de exclusão LGPD): apagar a LINHA sem
 * apagar o objeto deixaria bytes órfãos para sempre, e a exclusão física é
 * justamente a obrigação que esses fluxos precisam cumprir.
 */
export interface Storage {
  getObjectStream(key: string): Promise<Readable>;
  getObjectBuffer(key: string): Promise<Buffer>;
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;

  /**
   * Remove o objeto do bucket. IDEMPOTENTE no S3/MinIO: apagar uma chave que
   * não existe devolve sucesso, o que permite retomar um expurgo que falhou
   * no meio sem estado extra. (Atenção em buckets com VERSIONAMENTO ligado:
   * DeleteObject cria um delete marker e manteria as versões antigas — por
   * isso o bucket de mídia deve rodar sem versionamento, ver DEPLOYMENT.md.)
   */
  deleteObject(key: string): Promise<void>;

  /**
   * URL assinada e temporária de onde uma plataforma pode BUSCAR a mídia.
   *
   * A Meta não aceita upload direto: ela exige que o arquivo esteja numa URL
   * que os servidores dela alcancem. A validade precisa cobrir todo o
   * processamento remoto — a Meta leva minutos para buscar e transcodificar
   * um vídeo, e uma URL que expira no meio faz o contêiner falhar.
   */
  getSignedDownloadUrl(key: string, expiresInSeconds?: number): Promise<string>;
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

  async getSignedDownloadUrl(key: string, expiresInSeconds = 3600): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
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

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
