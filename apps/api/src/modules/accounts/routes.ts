import { PLATFORM_KEYS, type PlatformKey } from '@app/core';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { requireAuth } from '../../plugins/auth.js';
import type { AppInstance } from '../../types.js';
import { OAuthService } from './oauth-service.js';
import { AccountService } from './service.js';

const platformParam = z.object({ platform: z.enum(PLATFORM_KEYS) });

const accountSchema = z.object({
  id: z.string(),
  platform: z.enum(PLATFORM_KEYS),
  platformName: z.string(),
  nickname: z.string(),
  timezone: z.string(),
  status: z.string(),
  statusReason: z.string().nullable(),
  remoteId: z.string(),
  remoteUsername: z.string().nullable(),
  remoteDisplayName: z.string().nullable(),
  remoteAvatarUrl: z.string().nullable(),
  remoteProfileUrl: z.string().nullable(),
  isBusinessAccount: z.boolean(),
  clientId: z.string(),
  clientName: z.string(),
  connectedAt: z.string(),
  lastPublishedAt: z.string().nullable(),
  token: z.object({
    expiresAt: z.string().nullable(),
    scopes: z.array(z.string()),
    needsReconnect: z.boolean(),
  }),
  groups: z.array(z.object({ id: z.string(), name: z.string() })),
  queueSlots: z.array(
    z.object({ weekday: z.number(), hour: z.number(), minute: z.number() }),
  ),
});

export async function registerAccountRoutes(
  app: AppInstance,
  container: Container,
): Promise<void> {
  const accounts = new AccountService(container);
  const oauth = new OAuthService(container);

  // --- Listagem -------------------------------------------------------------
  app.get(
    '/accounts',
    {
      preHandler: app.requirePermission('account:read'),
      schema: {
        tags: ['Contas'],
        summary: 'Lista as contas conectadas (várias por rede)',
        querystring: z.object({
          platform: z.enum(PLATFORM_KEYS).optional(),
          clientId: z.string().uuid().optional(),
          groupId: z.string().uuid().optional(),
        }),
        response: {
          200: z.object({
            accounts: z.array(accountSchema),
            /** Agrupado por rede, como a tela de contas conectadas espera. */
            byPlatform: z.record(z.array(accountSchema)),
          }),
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const list = await accounts.list(auth, request.query);

      const byPlatform: Record<string, typeof list> = {};
      for (const account of list) {
        (byPlatform[account.platform] ??= []).push(account);
      }

      return { accounts: list, byPlatform };
    },
  );

  app.get(
    '/accounts/:accountId',
    {
      preHandler: app.requirePermission('account:read'),
      schema: {
        tags: ['Contas'],
        summary: 'Detalhe de uma conta conectada',
        params: z.object({ accountId: z.string().uuid() }),
        response: { 200: accountSchema },
      },
    },
    async (request) => accounts.get(requireAuth(request), request.params.accountId),
  );

  // --- Edição ---------------------------------------------------------------
  app.patch(
    '/accounts/:accountId',
    {
      preHandler: app.requirePermission('account:update'),
      schema: {
        tags: ['Contas'],
        summary: 'Altera apelido interno e fuso horário da conta',
        params: z.object({ accountId: z.string().uuid() }),
        body: z.object({
          nickname: z.string().min(1).max(120).optional(),
          // Fuso da CONTA: é ele que define o que "segunda às 10h" significa
          // para os destinos desta conta (SPEC seção 6.1).
          timezone: z.string().min(1).max(64).optional(),
        }),
        response: { 200: accountSchema },
      },
    },
    async (request) =>
      accounts.update(
        requireAuth(request),
        request.params.accountId,
        request.body,
        request.correlationId,
      ),
  );

  app.post(
    '/accounts/:accountId/disconnect',
    {
      preHandler: app.requirePermission('account:disconnect'),
      schema: {
        tags: ['Contas'],
        summary: 'Desconecta a conta e revoga o token na plataforma',
        params: z.object({ accountId: z.string().uuid() }),
        response: {
          200: z.object({
            revokedRemotely: z.boolean(),
            scheduledTargetsCancelled: z.number(),
          }),
        },
      },
    },
    async (request) =>
      accounts.disconnect(
        requireAuth(request),
        request.params.accountId,
        request.correlationId,
      ),
  );

  // --- OAuth ----------------------------------------------------------------
  app.post(
    '/oauth/:platform/start',
    {
      preHandler: app.requirePermission('account:connect'),
      schema: {
        tags: ['Contas'],
        summary: 'Inicia a conexão OAuth e devolve a URL de autorização',
        description:
          'A resposta inclui os escopos que serão solicitados e o que cada um permite, ' +
          'para a interface mostrar o consentimento antes de redirecionar (SPEC seção 11).',
        params: platformParam,
        body: z.object({
          clientId: z.string().uuid(),
          nickname: z.string().min(1).max(120),
          timezone: z.string().min(1).max(64).optional(),
          reconnectAccountId: z.string().uuid().optional(),
          returnTo: z.string().max(500).optional(),
        }),
        response: {
          200: z.object({
            authorizationUrl: z.string(),
            state: z.string(),
            consent: z.object({
              platform: z.enum(PLATFORM_KEYS),
              platformName: z.string(),
              scopes: z.array(z.object({ scope: z.string(), description: z.string() })),
              docsUrl: z.string().nullable(),
            }),
          }),
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);

      // Reconexão não consome vaga nova: só conexão de conta inédita.
      if (!request.body.reconnectAccountId) {
        await oauth.assertAccountLimit(auth.organizationId);
      }

      return oauth.start({
        platform: request.params.platform,
        organizationId: auth.organizationId,
        userId: auth.userId,
        ...request.body,
      });
    },
  );

  /**
   * Callback da plataforma.
   *
   * Sem autenticação de sessão de propósito: quem chama é o navegador vindo
   * do site da plataforma, e o cookie de sessão pode não acompanhar o
   * redirecionamento entre sites. Quem autoriza é o `state`, que foi criado
   * por um usuário autenticado e vive por 10 minutos no Redis.
   */
  app.get(
    '/oauth/:platform/callback',
    {
      schema: {
        tags: ['Contas'],
        summary: 'Recebe o retorno da plataforma e conclui a conexão',
        security: [],
        params: platformParam,
        querystring: z.object({
          code: z.string().optional(),
          state: z.string().optional(),
          error: z.string().optional(),
          error_description: z.string().optional(),
        }),
      },
    },
    async (request, reply) => {
      const web = container.env.WEB_PUBLIC_URL.replace(/\/$/, '');
      const { code, state, error, error_description: description } = request.query;

      // O usuário recusou a autorização na tela da plataforma.
      if (error) {
        request.log.info({ error, description }, 'autorização recusada pelo usuário');
        return reply.redirect(
          `${web}/contas?erro=${encodeURIComponent(description ?? error)}`,
        );
      }

      if (!code || !state) {
        return reply.redirect(
          `${web}/contas?erro=${encodeURIComponent('Retorno da plataforma incompleto.')}`,
        );
      }

      try {
        const result = await oauth.handleCallback({
          platform: request.params.platform as PlatformKey,
          code,
          state,
          correlationId: request.correlationId,
          ipAddress: request.ip,
          ...(typeof request.headers['user-agent'] === 'string'
            ? { userAgent: request.headers['user-agent'] }
            : {}),
        });

        const destination = result.returnTo?.startsWith('/')
          ? `${web}${result.returnTo}`
          : `${web}/contas`;

        const separator = destination.includes('?') ? '&' : '?';
        return reply.redirect(
          `${destination}${separator}conta=${result.socialAccountId}` +
            `&status=${result.reconnected ? 'reconectada' : 'conectada'}`,
        );
      } catch (caught) {
        // O erro vai para o log completo; o usuário recebe a mensagem legível
        // na tela de contas, em vez de um JSON de erro no meio do navegador.
        request.log.error({ err: caught }, 'falha ao concluir a conexão OAuth');
        const message =
          caught instanceof Error ? caught.message : 'Não foi possível concluir a conexão.';
        return reply.redirect(`${web}/contas?erro=${encodeURIComponent(message)}`);
      }
    },
  );
}
