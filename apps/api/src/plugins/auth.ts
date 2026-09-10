import {
  ForbiddenError,
  UnauthorizedError,
  canAccessClient,
  roleHasPermission,
  type Permission,
  type RoleName,
} from '@app/core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { Container } from '../container.js';
import { verifyAccessToken } from '../lib/jwt.js';

/**
 * Autenticação e autorização.
 *
 * O contexto autenticado carrega SEMPRE a organização. Não existe consulta
 * "sem tenant" nesta API — é assim que o isolamento da SPEC seção 5 deixa de
 * depender de o desenvolvedor lembrar de filtrar.
 */

export interface AuthContext {
  userId: string;
  organizationId: string;
  role: RoleName;
  scopedClientIds: string[];
  mfaSatisfied: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }

  interface FastifyInstance {
    /** Exige sessão válida. Use como `preHandler`. */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Exige sessão válida + permissão específica. */
    requirePermission: (
      permission: Permission,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export function createAuthPlugin(container: Container): FastifyPluginAsync {
  return fp(
    async (app) => {
      app.decorateRequest('auth', undefined);

      app.decorate('authenticate', async (request: FastifyRequest) => {
        const header = request.headers.authorization;

        if (!header?.startsWith('Bearer ')) {
          throw new UnauthorizedError('Envie o token de acesso no header Authorization.');
        }

        const token = header.slice('Bearer '.length).trim();

        let claims;
        try {
          claims = await verifyAccessToken(token, container.env.JWT_ACCESS_SECRET);
        } catch {
          // Não distinguimos "expirado" de "inválido" na resposta: a diferença
          // ajuda mais quem está testando token roubado do que o usuário.
          throw new UnauthorizedError('Sessão inválida ou expirada. Entre novamente.');
        }

        // O papel pode ter mudado depois de o token ser emitido. Reler o
        // vínculo a cada requisição é o que faz uma remoção de acesso valer
        // imediatamente, em vez de só quando o token de 15 min expirar.
        const membership = await container.prisma.membership.findUnique({
          where: {
            organizationId_userId: {
              organizationId: claims.org,
              userId: claims.sub,
            },
          },
          select: {
            role: true,
            status: true,
            scopedClientIds: true,
            deletedAt: true,
            user: { select: { deletedAt: true, lockedUntil: true } },
            organization: { select: { deletedAt: true } },
          },
        });

        if (
          !membership ||
          membership.deletedAt !== null ||
          membership.status !== 'ACTIVE' ||
          membership.user.deletedAt !== null ||
          membership.organization.deletedAt !== null
        ) {
          throw new UnauthorizedError('Seu acesso a esta organização não está mais ativo.');
        }

        if (membership.user.lockedUntil && membership.user.lockedUntil > new Date()) {
          throw new UnauthorizedError('Conta temporariamente bloqueada. Tente mais tarde.');
        }

        request.auth = {
          userId: claims.sub,
          organizationId: claims.org,
          role: membership.role,
          scopedClientIds: membership.scopedClientIds,
          mfaSatisfied: claims.mfa === true,
        };
      });

      app.decorate('requirePermission', (permission: Permission) => {
        return async (request: FastifyRequest, reply: FastifyReply) => {
          await app.authenticate(request, reply);

          const auth = request.auth;
          if (!auth) throw new UnauthorizedError();

          if (!roleHasPermission(auth.role, permission)) {
            throw new ForbiddenError(
              `Seu papel (${auth.role}) não permite esta ação (${permission}).`,
            );
          }
        };
      });
    },
    { name: 'auth' },
  );
}

// ---------------------------------------------------------------------------
//  Auxiliares usados pelos módulos
// ---------------------------------------------------------------------------

export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new UnauthorizedError();
  return request.auth;
}

export function assertPermission(auth: AuthContext, permission: Permission): void {
  if (!roleHasPermission(auth.role, permission)) {
    throw new ForbiddenError(`Seu papel (${auth.role}) não permite esta ação (${permission}).`);
  }
}

/**
 * Membro com escopo por cliente não pode agir em cliente fora do escopo,
 * mesmo tendo o papel certo.
 */
export function assertClientAccess(auth: AuthContext, clientId: string | null): void {
  if (!canAccessClient(auth.scopedClientIds, clientId)) {
    throw new ForbiddenError('Seu acesso está limitado a outros clientes desta organização.');
  }
}

/**
 * 2FA obrigatório para Owner/Admin a partir de determinado plano
 * (SPEC seção 10). A checagem fica aqui para ser aplicada em rotas sensíveis.
 */
export function assertMfaWhenRequired(
  auth: AuthContext,
  planRequiresMfa: boolean,
): void {
  const privileged = auth.role === 'OWNER' || auth.role === 'ADMIN';
  if (planRequiresMfa && privileged && !auth.mfaSatisfied) {
    throw new ForbiddenError(
      'Seu plano exige autenticação de dois fatores para papéis administrativos. ' +
        'Ative o 2FA nas configurações da sua conta.',
    );
  }
}
