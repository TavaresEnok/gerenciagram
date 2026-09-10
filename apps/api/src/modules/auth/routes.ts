import { ForbiddenError, UnauthorizedError } from '@app/core';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { requireAuth } from '../../plugins/auth.js';
import type { AppInstance } from '../../types.js';
import { AuthService, toPublicUser, type RequestMeta } from './service.js';

/**
 * Rotas de autenticação.
 *
 * O refresh token vai em cookie httpOnly, não no corpo da resposta: assim ele
 * fica fora do alcance de JavaScript e, portanto, de XSS. O access token, de
 * vida curta, volta no corpo para o cliente mandar no header Authorization.
 * (SPEC seções 10 e 19 — "tokens no frontend" se refere a token de PLATAFORMA;
 * o de sessão precisa chegar ao cliente de alguma forma, e esta é a segura.)
 */

const REFRESH_COOKIE = 'grs_refresh';

const publicUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
  timezone: z.string(),
  locale: z.string(),
  emailVerified: z.boolean(),
  twoFactorEnabled: z.boolean(),
});

const sessionSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number(),
  user: publicUserSchema,
  organizationId: z.string(),
});

const passwordField = z.string().min(12, 'A senha precisa ter pelo menos 12 caracteres').max(200);

export async function registerAuthRoutes(
  app: AppInstance,
  container: Container,
): Promise<void> {
  const service = new AuthService(container);

  const meta = (request: { ip: string; headers: Record<string, unknown>; correlationId: string }): RequestMeta => ({
    ipAddress: request.ip,
    userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : undefined,
    correlationId: request.correlationId,
  });

  const setRefreshCookie = (reply: { setCookie: (name: string, value: string, opts: object) => unknown }, token: string): void => {
    reply.setCookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: container.env.COOKIE_SECURE,
      sameSite: 'lax',
      path: '/v1/auth',
      maxAge: container.env.REFRESH_TOKEN_TTL,
    });
  };

  // --- Cadastro -------------------------------------------------------------
  app.post(
    '/auth/register',
    {
      config: { rateLimit: { max: 10, timeWindow: 3_600_000 } },
      schema: {
        tags: ['Autenticação'],
        summary: 'Cria conta, organização e vínculo de proprietário',
        security: [],
        body: z.object({
          email: z.string().email(),
          password: passwordField,
          name: z.string().min(2).max(120),
          organizationName: z.string().min(2).max(120),
          timezone: z.string().optional(),
        }),
        response: {
          201: z.object({ user: publicUserSchema, organizationId: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const result = await service.register({ ...request.body, meta: meta(request) });
      return reply.status(201).send(result);
    },
  );

  // --- Login ----------------------------------------------------------------
  app.post(
    '/auth/login',
    {
      // Limite mais apertado que o global: é o alvo óbvio de força bruta.
      config: { rateLimit: { max: 20, timeWindow: 900_000 } },
      schema: {
        tags: ['Autenticação'],
        summary: 'Autentica e abre sessão',
        security: [],
        body: z.object({
          email: z.string().email(),
          password: z.string().min(1),
          organizationId: z.string().uuid().optional(),
        }),
        response: {
          200: z.union([
            sessionSchema,
            z.object({ status: z.literal('mfa_required'), challengeToken: z.string() }),
            z.object({ status: z.literal('no_organization'), user: publicUserSchema }),
          ]),
        },
      },
    },
    async (request, reply) => {
      const result = await service.login({ ...request.body, meta: meta(request) });

      if (result.status === 'mfa_required') {
        return reply.send({ status: 'mfa_required' as const, challengeToken: result.challengeToken });
      }
      if (result.status === 'no_organization') {
        return reply.send({ status: 'no_organization' as const, user: result.user });
      }

      setRefreshCookie(reply, result.tokens.refreshToken);
      return reply.send({
        accessToken: result.tokens.accessToken,
        expiresIn: result.tokens.expiresIn,
        user: result.user,
        organizationId: result.organizationId,
      });
    },
  );

  app.post(
    '/auth/login/mfa',
    {
      config: { rateLimit: { max: 20, timeWindow: 900_000 } },
      schema: {
        tags: ['Autenticação'],
        summary: 'Conclui o login com o segundo fator',
        security: [],
        body: z.object({
          challengeToken: z.string(),
          code: z.string().min(6).max(20),
          organizationId: z.string().uuid().optional(),
        }),
        response: { 200: sessionSchema },
      },
    },
    async (request, reply) => {
      const result = await service.verifyMfaAndLogin({ ...request.body, meta: meta(request) });

      if (result.status !== 'ok') {
        throw new ForbiddenError('Sua conta não está vinculada a nenhuma organização ativa.');
      }

      setRefreshCookie(reply, result.tokens.refreshToken);
      return reply.send({
        accessToken: result.tokens.accessToken,
        expiresIn: result.tokens.expiresIn,
        user: result.user,
        organizationId: result.organizationId,
      });
    },
  );

  // --- Sessão ---------------------------------------------------------------
  app.post(
    '/auth/refresh',
    {
      schema: {
        tags: ['Autenticação'],
        summary: 'Renova o access token, rotacionando o refresh',
        security: [],
        body: z
          .object({ organizationId: z.string().uuid().optional() })
          .optional()
          .default({}),
        response: {
          200: z.object({ accessToken: z.string(), expiresIn: z.number() }),
        },
      },
    },
    async (request, reply) => {
      const token = request.cookies[REFRESH_COOKIE];
      if (!token) {
        throw new UnauthorizedError('Sessão não encontrada. Entre novamente.');
      }

      const tokens = await service.refresh({
        refreshToken: token,
        ...(request.body?.organizationId ? { organizationId: request.body.organizationId } : {}),
        meta: meta(request),
      });

      setRefreshCookie(reply, tokens.refreshToken);
      return reply.send({ accessToken: tokens.accessToken, expiresIn: tokens.expiresIn });
    },
  );

  app.post(
    '/auth/logout',
    {
      schema: {
        tags: ['Autenticação'],
        summary: 'Encerra a sessão atual',
        security: [],
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const token = request.cookies[REFRESH_COOKIE];
      if (token) await service.logout(token, meta(request));

      reply.clearCookie(REFRESH_COOKIE, { path: '/v1/auth' });
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/auth/logout-all',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Autenticação'],
        summary: 'Encerra todas as sessões deste usuário',
        response: { 200: z.object({ sessionsRevoked: z.number() }) },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const count = await service.logoutAllSessions(auth.userId, meta(request));
      reply.clearCookie(REFRESH_COOKIE, { path: '/v1/auth' });
      return reply.send({ sessionsRevoked: count });
    },
  );

  // --- Usuário atual --------------------------------------------------------
  app.get(
    '/auth/me',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Autenticação'],
        summary: 'Dados do usuário autenticado e suas organizações',
        response: {
          200: z.object({
            user: publicUserSchema,
            currentOrganizationId: z.string(),
            role: z.string(),
            scopedClientIds: z.array(z.string()),
            mfaSatisfied: z.boolean(),
            organizations: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                slug: z.string(),
                role: z.string(),
              }),
            ),
          }),
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);

      const user = await container.prisma.user.findUniqueOrThrow({
        where: { id: auth.userId },
        include: {
          memberships: {
            where: { status: 'ACTIVE', deletedAt: null, organization: { deletedAt: null } },
            include: { organization: { select: { id: true, name: true, slug: true } } },
            orderBy: { createdAt: 'asc' },
          },
        },
      });

      return {
        user: toPublicUser(user),
        currentOrganizationId: auth.organizationId,
        role: auth.role,
        scopedClientIds: auth.scopedClientIds,
        mfaSatisfied: auth.mfaSatisfied,
        organizations: user.memberships.map((m) => ({
          id: m.organization.id,
          name: m.organization.name,
          slug: m.organization.slug,
          role: m.role,
        })),
      };
    },
  );

  // --- E-mail e senha -------------------------------------------------------
  app.post(
    '/auth/verify-email',
    {
      schema: {
        tags: ['Autenticação'],
        summary: 'Confirma o e-mail a partir do link recebido',
        security: [],
        body: z.object({ token: z.string().min(10) }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      await service.verifyEmail(request.body.token);
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/auth/verify-email/resend',
    {
      preHandler: app.authenticate,
      config: { rateLimit: { max: 5, timeWindow: 3_600_000 } },
      schema: {
        tags: ['Autenticação'],
        summary: 'Reenvia o e-mail de confirmação',
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const user = await container.prisma.user.findUniqueOrThrow({
        where: { id: auth.userId },
        select: { email: true, emailVerified: true },
      });

      if (!user.emailVerified) await service.sendEmailVerification(user.email);
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/auth/password/forgot',
    {
      config: { rateLimit: { max: 5, timeWindow: 3_600_000 } },
      schema: {
        tags: ['Autenticação'],
        summary: 'Solicita link de redefinição de senha',
        security: [],
        body: z.object({ email: z.string().email() }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      await service.requestPasswordReset(request.body.email);
      // 204 sempre, exista ou não a conta — ver comentário no serviço.
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/auth/password/reset',
    {
      config: { rateLimit: { max: 10, timeWindow: 3_600_000 } },
      schema: {
        tags: ['Autenticação'],
        summary: 'Redefine a senha usando o token do e-mail',
        security: [],
        body: z.object({ token: z.string().min(10), newPassword: passwordField }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      await service.resetPassword(request.body.token, request.body.newPassword, meta(request));
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/auth/password/change',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Autenticação'],
        summary: 'Troca a senha do usuário autenticado',
        body: z.object({ currentPassword: z.string().min(1), newPassword: passwordField }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      await service.changePassword(
        auth.userId,
        request.body.currentPassword,
        request.body.newPassword,
        meta(request),
      );
      return reply.status(204).send(null);
    },
  );

  // --- Convites -------------------------------------------------------------
  app.post(
    '/auth/invite/accept',
    {
      schema: {
        tags: ['Autenticação'],
        summary: 'Aceita um convite para uma organização',
        security: [],
        body: z.object({
          token: z.string().min(10),
          name: z.string().min(2).max(120).optional(),
          password: passwordField.optional(),
        }),
        response: {
          200: z.object({ organizationId: z.string(), userId: z.string() }),
        },
      },
    },
    async (request) => service.acceptInvite({ ...request.body, meta: meta(request) }),
  );

  // --- 2FA ------------------------------------------------------------------
  app.post(
    '/auth/2fa/setup',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Autenticação'],
        summary: 'Inicia a configuração do segundo fator (gera QR code)',
        response: {
          200: z.object({
            secret: z.string(),
            otpauthUrl: z.string(),
            qrCodeDataUrl: z.string(),
          }),
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      return service.beginTwoFactorSetup(auth.userId);
    },
  );

  app.post(
    '/auth/2fa/confirm',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Autenticação'],
        summary: 'Confirma o 2FA e devolve os códigos de recuperação',
        body: z.object({ code: z.string().min(6).max(10) }),
        response: { 200: z.object({ recoveryCodes: z.array(z.string()) }) },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      return service.confirmTwoFactorSetup(auth.userId, request.body.code, meta(request));
    },
  );

  app.post(
    '/auth/2fa/disable',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Autenticação'],
        summary: 'Desativa o segundo fator (exige a senha)',
        body: z.object({ password: z.string().min(1) }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      await service.disableTwoFactor(auth.userId, request.body.password, meta(request));
      return reply.status(204).send(null);
    },
  );
}
