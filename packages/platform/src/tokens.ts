import {
  TokenExpiredError,
  type AdapterContext,
  type PlatformCredentials,
  type PlatformKey,
} from '@app/core';
import type { PrismaClient } from '@app/db';
import { decrypt, encrypt, type EncryptionKeyring } from './crypto.js';
import type { PlatformServices } from './registry.js';

/**
 * Ciclo de vida dos tokens de conta (SPEC seções 6 e 10).
 *
 * Regras que este módulo garante:
 *  - o token em claro nunca é persistido, logado ou devolvido ao frontend;
 *  - a renovação acontece ANTES de expirar (margem de segurança), porque
 *    descobrir a expiração no meio de um upload de vídeo custa o upload inteiro;
 *  - refresh token revogado marca a conta como NEEDS_RECONNECT e para de
 *    tentar, em vez de queimar as tentativas de retry do destino.
 */

/**
 * Renova quando falta menos que isto para expirar. O access token do Google
 * dura 1h; 5 minutos de margem cobrem tanto o relógio fora de sincronia
 * quanto uma publicação que demora a subir.
 */
const REFRESH_MARGIN_MS = 5 * 60_000;

export interface TokenServiceDeps {
  prisma: PrismaClient;
  keyring: EncryptionKeyring;
  platforms: PlatformServices;
}

export interface StoredCredentials {
  credentials: PlatformCredentials;
  /** true quando este acesso foi renovado agora. */
  refreshed: boolean;
}

export function decryptCredentials(
  token: {
    accessTokenEnc: string;
    refreshTokenEnc: string | null;
    accessTokenExpiresAt: Date | null;
    scopes: string[];
  },
  keyring: EncryptionKeyring,
): PlatformCredentials {
  const credentials: PlatformCredentials = {
    accessToken: decrypt(token.accessTokenEnc, keyring),
    scopes: token.scopes,
  };

  if (token.refreshTokenEnc) {
    credentials.refreshToken = decrypt(token.refreshTokenEnc, keyring);
  }
  if (token.accessTokenExpiresAt) {
    credentials.expiresAt = token.accessTokenExpiresAt;
  }

  return credentials;
}

export async function persistCredentials(
  deps: TokenServiceDeps,
  socialAccountId: string,
  organizationId: string,
  credentials: PlatformCredentials,
): Promise<void> {
  const access = encrypt(credentials.accessToken, deps.keyring);
  const refresh = credentials.refreshToken
    ? encrypt(credentials.refreshToken, deps.keyring)
    : null;

  await deps.prisma.oAuthToken.upsert({
    where: { socialAccountId },
    create: {
      socialAccountId,
      organizationId,
      accessTokenEnc: access.ciphertext,
      refreshTokenEnc: refresh?.ciphertext ?? null,
      keyVersion: access.keyVersion,
      scopes: credentials.scopes,
      accessTokenExpiresAt: credentials.expiresAt ?? null,
      lastRefreshedAt: new Date(),
      refreshFailureCount: 0,
    },
    update: {
      accessTokenEnc: access.ciphertext,
      // Não apagamos o refresh token quando a renovação não devolve um novo:
      // o Google só manda refresh token na primeira autorização, e sobrescrever
      // com null obrigaria o usuário a reconectar em 1 hora.
      ...(refresh ? { refreshTokenEnc: refresh.ciphertext } : {}),
      keyVersion: access.keyVersion,
      scopes: credentials.scopes,
      accessTokenExpiresAt: credentials.expiresAt ?? null,
      lastRefreshedAt: new Date(),
      refreshFailureCount: 0,
      revokedAt: null,
    },
  });
}

/**
 * Devolve credenciais VÁLIDAS para uma conta, renovando se preciso.
 *
 * É o único caminho pelo qual API e worker obtêm token de plataforma.
 */
export async function getValidCredentials(
  deps: TokenServiceDeps,
  socialAccountId: string,
  ctx: AdapterContext,
): Promise<StoredCredentials> {
  const account = await deps.prisma.socialAccount.findUnique({
    where: { id: socialAccountId },
    include: { oauthToken: true },
  });

  if (!account || account.deletedAt) {
    throw new TokenExpiredError('plataforma', 'Conta conectada não encontrada.');
  }
  if (!account.oauthToken || account.oauthToken.revokedAt) {
    await markNeedsReconnect(deps.prisma, socialAccountId, 'Token revogado ou ausente.');
    throw new TokenExpiredError(
      account.platform,
      `A conta "${account.nickname}" precisa ser reconectada.`,
    );
  }

  const credentials = decryptCredentials(account.oauthToken, deps.keyring);

  const expiresAt = credentials.expiresAt?.getTime();
  const needsRefresh =
    expiresAt !== undefined && expiresAt - Date.now() <= REFRESH_MARGIN_MS;

  if (!needsRefresh) {
    return { credentials, refreshed: false };
  }

  return {
    credentials: await refreshCredentials(deps, account.id, account.organizationId, account.platform, account.nickname, credentials, ctx),
    refreshed: true,
  };
}

export async function refreshCredentials(
  deps: TokenServiceDeps,
  socialAccountId: string,
  organizationId: string,
  platform: PlatformKey,
  nickname: string,
  credentials: PlatformCredentials,
  ctx: AdapterContext,
): Promise<PlatformCredentials> {
  const adapter = deps.platforms.adapters.get(platform);
  const app = deps.platforms.appCredentials(platform);

  try {
    const renewed = await adapter.auth.refreshCredentials(app, credentials, ctx);
    await persistCredentials(deps, socialAccountId, organizationId, renewed);

    ctx.logger.info('token renovado', { socialAccountId, platform, correlationId: ctx.correlationId });
    return renewed;
  } catch (error) {
    const permanent = error instanceof TokenExpiredError;

    await deps.prisma.oAuthToken.update({
      where: { socialAccountId },
      data: {
        refreshFailureCount: { increment: 1 },
        ...(permanent ? { revokedAt: new Date() } : {}),
      },
    });

    if (permanent) {
      await markNeedsReconnect(
        deps.prisma,
        socialAccountId,
        'O acesso foi revogado na plataforma.',
      );
      throw new TokenExpiredError(
        platform,
        `A conta "${nickname}" precisa ser reconectada: o acesso foi revogado na plataforma.`,
      );
    }

    throw error;
  }
}

export async function markNeedsReconnect(
  prisma: PrismaClient,
  socialAccountId: string,
  reason: string,
): Promise<void> {
  await prisma.socialAccount.update({
    where: { id: socialAccountId },
    data: { status: 'NEEDS_RECONNECT', statusReason: reason },
  });
}

/**
 * Revoga o token junto à plataforma antes de apagar do banco.
 *
 * Exigido pelo direito de exclusão da LGPD (SPEC seção 11): remover a linha
 * local deixaria a autorização viva na plataforma.
 */
export async function revokeAndClear(
  deps: TokenServiceDeps,
  socialAccountId: string,
  ctx: AdapterContext,
): Promise<{ revokedRemotely: boolean; error?: string }> {
  const account = await deps.prisma.socialAccount.findUnique({
    where: { id: socialAccountId },
    include: { oauthToken: true },
  });

  if (!account?.oauthToken) return { revokedRemotely: false };

  let revokedRemotely = false;
  let errorMessage: string | undefined;

  try {
    const adapter = deps.platforms.adapters.get(account.platform);
    const app = deps.platforms.appCredentials(account.platform);
    const credentials = decryptCredentials(account.oauthToken, deps.keyring);

    await adapter.auth.revoke(app, credentials, ctx);
    revokedRemotely = true;
  } catch (error) {
    // A revogação remota pode falhar (plataforma fora do ar, token já morto).
    // Registramos e seguimos: manter o token cifrado no nosso banco seria pior.
    errorMessage = error instanceof Error ? error.message : String(error);
    ctx.logger.warn('não foi possível revogar o token na plataforma', {
      socialAccountId,
      platform: account.platform,
      error: errorMessage,
    });
  }

  await deps.prisma.oAuthToken.update({
    where: { socialAccountId },
    data: {
      accessTokenEnc: '',
      refreshTokenEnc: null,
      revokedAt: new Date(),
      scopes: [],
    },
  });

  return { revokedRemotely, ...(errorMessage ? { error: errorMessage } : {}) };
}
