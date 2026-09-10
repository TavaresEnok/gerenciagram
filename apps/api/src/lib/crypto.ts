import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Criptografia de tokens em repouso (SPEC seção 10).
 *
 * AES-256-GCM: além de cifrar, autentica. Um token adulterado no banco falha
 * na verificação da tag em vez de ser decifrado em lixo e enviado para a
 * plataforma.
 *
 * Formato: `v<versão>.<iv base64>.<authTag base64>.<ciphertext base64>`
 * A versão é o que permite rotacionar a chave (SPEC seção 10) sem obrigar
 * todos os usuários a reconectar suas contas: o registro guarda com qual
 * versão foi cifrado e a decifragem escolhe a chave correspondente.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // recomendado para GCM
const CURRENT_VERSION = 1;

export interface EncryptionKeyring {
  /** version -> chave de 32 bytes */
  keys: Map<number, Buffer>;
  currentVersion: number;
}

export function buildKeyring(currentKeyBase64: string, previousKeys: Record<number, string> = {}): EncryptionKeyring {
  const keys = new Map<number, Buffer>();

  for (const [version, value] of Object.entries(previousKeys)) {
    keys.set(Number(version), decodeKey(value));
  }
  keys.set(CURRENT_VERSION, decodeKey(currentKeyBase64));

  return { keys, currentVersion: CURRENT_VERSION };
}

function decodeKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) {
    throw new Error(
      'ENCRYPTION_KEY precisa ter exatamente 32 bytes em base64 ' +
        '(gere com: openssl rand -base64 32)',
    );
  }
  return key;
}

export interface EncryptedValue {
  ciphertext: string;
  keyVersion: number;
}

export function encrypt(plaintext: string, keyring: EncryptionKeyring): EncryptedValue {
  const key = keyring.keys.get(keyring.currentVersion);
  if (!key) throw new Error(`Chave de criptografia versão ${keyring.currentVersion} não encontrada`);

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: [
      `v${keyring.currentVersion}`,
      iv.toString('base64'),
      authTag.toString('base64'),
      encrypted.toString('base64'),
    ].join('.'),
    keyVersion: keyring.currentVersion,
  };
}

export function decrypt(value: string, keyring: EncryptionKeyring): string {
  const parts = value.split('.');
  if (parts.length !== 4) {
    throw new Error('Valor cifrado em formato inválido');
  }

  const [versionPart, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
  const version = Number(versionPart.replace(/^v/, ''));

  const key = keyring.keys.get(version);
  if (!key) {
    throw new Error(
      `Não é possível decifrar: a chave versão ${version} não está configurada. ` +
        `Ao rotacionar ENCRYPTION_KEY, mantenha a chave anterior disponível.`,
    );
  }

  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));

  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

// ---------------------------------------------------------------------------
//  Hashes e comparações
// ---------------------------------------------------------------------------

/**
 * Refresh tokens e tokens de e-mail são guardados como SHA-256. Não usamos
 * argon2 aqui de propósito: são valores aleatórios de alta entropia gerados
 * por nós, não senhas escolhidas por humanos — não há dicionário para atacar,
 * e o custo do argon2 em cada refresh atrapalharia o p95 da API.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Comparação em tempo constante, para não vazar informação por timing. */
export function safeCompare(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/** Checksum de arquivo, para deduplicação e detecção de conteúdo repetido. */
export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
