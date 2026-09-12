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

/** Versão usada quando o ambiente não declara `ENCRYPTION_KEY_VERSION`. */
export const DEFAULT_KEY_VERSION = 1;

export interface EncryptionKeyring {
  /** version -> chave de 32 bytes */
  keys: Map<number, Buffer>;
  currentVersion: number;
}

export interface KeyringOptions {
  /**
   * Versão da chave atual. Ao rotacionar, INCREMENTE — e mantenha a anterior
   * em `previousKeys`.
   */
  currentVersion?: number;
  /** Chaves antigas, por versão, para decifrar o que já está no banco. */
  previousKeys?: Record<number, string>;
}

/**
 * Monta o chaveiro.
 *
 * A versão da chave atual vem da CONFIGURAÇÃO, não de uma constante.
 *
 * Antes, `CURRENT_VERSION` era fixo em 1 e a chave nova sempre entrava nessa
 * versão — o que tornava a rotação impossível na prática: a chave nova
 * sobrescrevia a antiga no mesmo slot, todo texto cifrado marcado `v1`
 * passava a falhar na verificação da tag GCM, e TODOS os tokens OAuth viravam
 * lixo indecifrável, com cada conta precisando ser reconectada à mão. Era
 * exatamente o desastre que o versionamento existe para evitar.
 *
 * Rotacionar agora é:
 *   ENCRYPTION_KEY=<chave nova>
 *   ENCRYPTION_KEY_VERSION=2
 *   ENCRYPTION_KEYS_PREVIOUS={"1":"<chave antiga>"}
 *
 * O que já está no banco continua decifrando com a v1; o que for gravado
 * daqui em diante nasce v2. A chave antiga só pode ser descartada quando
 * nenhuma linha referenciar mais aquela versão.
 */
export function buildKeyring(
  currentKeyBase64: string,
  options: KeyringOptions = {},
): EncryptionKeyring {
  const currentVersion = options.currentVersion ?? DEFAULT_KEY_VERSION;

  if (!Number.isInteger(currentVersion) || currentVersion < 1) {
    throw new Error(
      `ENCRYPTION_KEY_VERSION precisa ser um inteiro >= 1 (recebido: ${currentVersion})`,
    );
  }

  const keys = new Map<number, Buffer>();

  for (const [version, value] of Object.entries(options.previousKeys ?? {})) {
    const parsed = Number(version);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`Versão de chave anterior inválida: "${version}"`);
    }
    if (parsed === currentVersion) {
      // Silenciar isto reintroduziria o bug original: a chave atual
      // sobrescrevendo a antiga no mesmo slot, sem ninguém perceber até a
      // primeira publicação falhar.
      throw new Error(
        `A versão ${parsed} aparece em ENCRYPTION_KEYS_PREVIOUS e também é a versão ` +
          `atual. Ao rotacionar, incremente ENCRYPTION_KEY_VERSION.`,
      );
    }
    keys.set(parsed, decodeKey(value));
  }

  keys.set(currentVersion, decodeKey(currentKeyBase64));

  return { keys, currentVersion };
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

/**
 * Interpreta `ENCRYPTION_KEYS_PREVIOUS` — as chaves antigas, em JSON por
 * versão: `{"1":"<base64 de 32 bytes>"}`.
 *
 * Vive aqui, e não no schema de ambiente de cada app, porque API e worker
 * PRECISAM interpretar isso de forma idêntica: é a API que cifra o token no
 * OAuth e o worker que o decifra para publicar. Duas implementações
 * divergentes fariam a publicação falhar com "chave versão N não
 * configurada" — e só em produção, no primeiro post depois da rotação.
 *
 * Lança com mensagem explicativa em vez de devolver vazio: uma chave anterior
 * mal escrita significa que os tokens já gravados não vão decifrar, e falhar
 * no boot é infinitamente melhor do que descobrir isso publicando.
 */
export function parsePreviousKeys(raw: string | undefined): Record<number, string> {
  if (!raw || raw.trim().length === 0) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      'ENCRYPTION_KEYS_PREVIOUS precisa ser um JSON como {"1":"<chave base64>"}',
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      'ENCRYPTION_KEYS_PREVIOUS precisa ser um objeto JSON mapeando versão para chave',
    );
  }

  const result: Record<number, string> = {};

  for (const [version, key] of Object.entries(parsed as Record<string, unknown>)) {
    const numero = Number(version);
    if (!Number.isInteger(numero) || numero < 1) {
      throw new Error(`ENCRYPTION_KEYS_PREVIOUS: versão inválida "${version}"`);
    }
    if (typeof key !== 'string' || Buffer.from(key, 'base64').length !== 32) {
      throw new Error(
        `ENCRYPTION_KEYS_PREVIOUS: a chave da versão ${numero} precisa ter 32 bytes em base64`,
      );
    }
    result[numero] = key;
  }

  return result;
}
