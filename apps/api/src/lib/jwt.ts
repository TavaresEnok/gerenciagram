import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { RoleName } from '@app/core';

/**
 * Tokens de sessão.
 *
 * Access token é JWT de vida curta (15 min) e NÃO é revogável — por isso é
 * curto. A revogação real acontece no refresh token, que é opaco, guardado
 * como hash no banco e rotacionado a cada uso. Reuso de um refresh já
 * rotacionado é tratado como sessão comprometida e revoga a família inteira.
 */

export interface AccessTokenClaims extends JWTPayload {
  sub: string;
  /** Organização ativa da sessão. */
  org: string;
  role: RoleName;
  /** Clientes aos quais o membro está limitado. Vazio = todos. */
  scoped: string[];
  /** Se o usuário já passou pelo segundo fator nesta sessão. */
  mfa: boolean;
}

export interface AccessTokenInput {
  userId: string;
  organizationId: string;
  role: RoleName;
  scopedClientIds: string[];
  mfaSatisfied: boolean;
}

const ISSUER = 'gerenciador-redes-sociais';
const AUDIENCE = 'gerenciador-api';

export async function signAccessToken(
  input: AccessTokenInput,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  const key = new TextEncoder().encode(secret);

  return new SignJWT({
    org: input.organizationId,
    role: input.role,
    scoped: input.scopedClientIds,
    mfa: input.mfaSatisfied,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(input.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key);
}

export async function verifyAccessToken(
  token: string,
  secret: string,
): Promise<AccessTokenClaims> {
  const key = new TextEncoder().encode(secret);
  const { payload } = await jwtVerify(token, key, {
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ['HS256'],
  });

  if (
    typeof payload.sub !== 'string' ||
    typeof payload.org !== 'string' ||
    typeof payload.role !== 'string'
  ) {
    throw new Error('Token de acesso com formato inesperado');
  }

  return payload as AccessTokenClaims;
}

/**
 * Token curto usado só entre "senha correta" e "segundo fator confirmado".
 * Não dá acesso a nada além do endpoint de verificação de 2FA.
 */
export async function signMfaChallengeToken(
  userId: string,
  secret: string,
  ttlSeconds = 300,
): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new SignJWT({ purpose: 'mfa_challenge' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key);
}

export async function verifyMfaChallengeToken(token: string, secret: string): Promise<string> {
  const key = new TextEncoder().encode(secret);
  const { payload } = await jwtVerify(token, key, {
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ['HS256'],
  });

  if (payload['purpose'] !== 'mfa_challenge' || typeof payload.sub !== 'string') {
    throw new Error('Token de desafio inválido');
  }
  return payload.sub;
}
