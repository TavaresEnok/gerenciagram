import { createHash, randomBytes } from 'node:crypto';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PlatformNotConfiguredError,
  UnauthorizedError,
  ValidationError,
  assertValidTimezone,
  getPlatformDefinition,
  type AdapterContext,
  type PlatformKey,
} from '@app/core';
import { persistCredentials } from '@app/platform';
import type { Container } from '../../container.js';
import { recordAudit } from '../../lib/audit.js';
import { adapterContext } from '../../lib/adapter-context.js';

/**
 * Fluxo de conexão de conta via OAuth (SPEC seções 6 e 11).
 *
 * Pontos que a implementação leva a sério:
 *
 *  - `state` é anti-CSRF de verdade: valor aleatório guardado no Redis com
 *    TTL curto e consumido UMA vez. Sem isso, um callback forjado conectaria
 *    a conta do atacante à organização da vítima.
 *  - PKCE quando a plataforma suporta, para o `code` interceptado não valer
 *    nada sem o verifier.
 *  - o token nunca passa pelo frontend: o callback bate direto na API, que
 *    cifra e guarda, e o navegador só recebe um redirecionamento.
 *  - transparência de consentimento (SPEC seção 11): o endpoint de início
 *    devolve os escopos que serão pedidos e o que cada um permite, para a UI
 *    exibir ANTES de mandar o usuário para a plataforma.
 */

const STATE_TTL_SECONDS = 600;

export interface OAuthStatePayload {
  organizationId: string;
  userId: string;
  clientId: string;
  platform: PlatformKey;
  nickname: string;
  timezone: string;
  codeVerifier: string;
  /** Preenchido quando é reconexão de uma conta existente. */
  reconnectAccountId?: string;
  returnTo?: string;
}

export interface StartResult {
  authorizationUrl: string;
  state: string;
  /** Para a UI mostrar o que está sendo concedido antes de redirecionar. */
  consent: {
    platform: PlatformKey;
    platformName: string;
    scopes: Array<{ scope: string; description: string }>;
    docsUrl: string | null;
  };
}

/**
 * O que cada escopo permite, em português.
 *
 * Fica no backend porque é informação de conformidade, não de layout: se a
 * lista de escopos mudar, a explicação precisa mudar junto, no mesmo lugar.
 */
const SCOPE_DESCRIPTIONS: Record<string, string> = {
  'https://www.googleapis.com/auth/youtube.upload':
    'Enviar vídeos para o seu canal. Não permite apagar vídeos existentes.',
  'https://www.googleapis.com/auth/youtube.readonly':
    'Ler os dados públicos do canal, a lista de vídeos e as estatísticas.',
  'https://www.googleapis.com/auth/youtube.force-ssl':
    'Gerenciar o canal, incluindo responder e moderar comentários.',
};

export class OAuthService {
  constructor(private readonly container: Container) {}

  /** Passo 1: monta a URL de autorização e guarda o state. */
  async start(input: {
    platform: PlatformKey;
    organizationId: string;
    userId: string;
    clientId: string;
    nickname: string;
    timezone?: string;
    reconnectAccountId?: string;
    returnTo?: string;
  }): Promise<StartResult> {
    const definition = getPlatformDefinition(input.platform);

    if (!definition.isAvailable) {
      throw new ValidationError(
        definition.unavailableReason ??
          `Este recurso não está disponível pela API oficial desta plataforma (${definition.displayName}).`,
      );
    }
    if (!this.container.configuredPlatforms.has(input.platform)) {
      throw new PlatformNotConfiguredError(definition.displayName);
    }

    const client = await this.container.prisma.client.findFirst({
      where: {
        id: input.clientId,
        organizationId: input.organizationId,
        deletedAt: null,
      },
      select: { id: true, timezone: true },
    });
    if (!client) throw new NotFoundError('Cliente', input.clientId);

    // O fuso da conta é herdado do cliente e pode ser sobrescrito (SPEC 6.1).
    const timezone = input.timezone ?? client.timezone;
    assertValidTimezone(timezone);

    if (input.reconnectAccountId) {
      const existing = await this.container.prisma.socialAccount.findFirst({
        where: {
          id: input.reconnectAccountId,
          organizationId: input.organizationId,
          deletedAt: null,
        },
        select: { id: true, platform: true },
      });
      if (!existing) throw new NotFoundError('Conta conectada', input.reconnectAccountId);
      if (existing.platform !== input.platform) {
        throw new ValidationError(
          'A conta a reconectar pertence a outra rede social.',
        );
      }
    }

    const adapter = this.container.adapters.get(input.platform);
    const app = this.container.platforms.appCredentials(input.platform);

    const state = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

    const payload: OAuthStatePayload = {
      organizationId: input.organizationId,
      userId: input.userId,
      clientId: input.clientId,
      platform: input.platform,
      nickname: input.nickname.trim(),
      timezone,
      codeVerifier,
      ...(input.reconnectAccountId ? { reconnectAccountId: input.reconnectAccountId } : {}),
      ...(input.returnTo ? { returnTo: input.returnTo } : {}),
    };

    await this.container.redis.set(
      this.stateKey(state),
      JSON.stringify(payload),
      'EX',
      STATE_TTL_SECONDS,
    );

    const authorizationUrl = adapter.auth.buildAuthorizationUrl(app, {
      state,
      scopes: definition.oauthScopes,
      codeChallenge,
    });

    return {
      authorizationUrl,
      state,
      consent: {
        platform: input.platform,
        platformName: definition.displayName,
        scopes: definition.oauthScopes.map((scope) => ({
          scope,
          description: SCOPE_DESCRIPTIONS[scope] ?? 'Permissão solicitada pela plataforma.',
        })),
        docsUrl: definition.docsUrl,
      },
    };
  }

  /** Passo 2: consome o state, troca o código por tokens e grava a conta. */
  async handleCallback(input: {
    platform: PlatformKey;
    code: string;
    state: string;
    correlationId: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<{ socialAccountId: string; returnTo?: string; reconnected: boolean }> {
    const raw = await this.container.redis.getdel(this.stateKey(input.state));
    if (!raw) {
      // State ausente = expirado, já usado, ou forjado. Os três casos têm a
      // mesma resposta: não conectamos nada.
      throw new UnauthorizedError(
        'A autorização expirou ou é inválida. Inicie a conexão novamente.',
      );
    }

    const payload = JSON.parse(raw) as OAuthStatePayload;

    if (payload.platform !== input.platform) {
      throw new ValidationError('A autorização não corresponde a esta rede social.');
    }

    const ctx = adapterContext(this.container, input.correlationId, 30_000);
    const adapter = this.container.adapters.get(payload.platform);
    const app = this.container.platforms.appCredentials(payload.platform);

    const { credentials, identity } = await adapter.auth.exchangeCodeForTokens(
      app,
      { code: input.code, codeVerifier: payload.codeVerifier },
      ctx,
    );

    const result = await this.persistAccount(payload, identity, input.correlationId);

    await persistCredentials(
      {
        prisma: this.container.prisma,
        keyring: this.container.keyring,
        platforms: this.container.platforms,
      },
      result.socialAccountId,
      payload.organizationId,
      credentials,
    );

    await recordAudit(this.container.prisma, {
      organizationId: payload.organizationId,
      actorUserId: payload.userId,
      action: result.reconnected ? 'account.reconnect' : 'account.connect',
      entityType: 'SocialAccount',
      entityId: result.socialAccountId,
      changes: {
        platform: payload.platform,
        remoteId: identity.remoteId,
        nickname: payload.nickname,
        scopes: credentials.scopes,
      },
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      correlationId: input.correlationId,
    });

    return {
      socialAccountId: result.socialAccountId,
      reconnected: result.reconnected,
      ...(payload.returnTo ? { returnTo: payload.returnTo } : {}),
    };
  }

  private async persistAccount(
    payload: OAuthStatePayload,
    identity: { remoteId: string; username?: string; displayName?: string; avatarUrl?: string; profileUrl?: string; isBusinessAccount?: boolean; metadata?: Record<string, unknown> },
    correlationId: string,
  ): Promise<{ socialAccountId: string; reconnected: boolean }> {
    const { prisma } = this.container;

    // Já existe uma conta com este remoteId nesta organização?
    const existingByRemote = await prisma.socialAccount.findUnique({
      where: {
        organizationId_platform_remoteId: {
          organizationId: payload.organizationId,
          platform: payload.platform,
          remoteId: identity.remoteId,
        },
      },
    });

    const identityData = {
      remoteUsername: identity.username ?? null,
      remoteDisplayName: identity.displayName ?? null,
      remoteAvatarUrl: identity.avatarUrl ?? null,
      remoteProfileUrl: identity.profileUrl ?? null,
      isBusinessAccount: identity.isBusinessAccount ?? false,
      metadata: (identity.metadata ?? {}) as object,
      status: 'ACTIVE' as const,
      statusReason: null,
      lastCheckedAt: new Date(),
    };

    if (payload.reconnectAccountId) {
      // Reconexão: o usuário precisa autorizar A MESMA conta. Autorizar outro
      // perfil por engano trocaria silenciosamente o destino de todos os
      // agendamentos futuros daquela conta.
      const target = await prisma.socialAccount.findUniqueOrThrow({
        where: { id: payload.reconnectAccountId },
      });

      if (target.remoteId !== identity.remoteId) {
        throw new ConflictError(
          `Você autorizou o perfil "${identity.displayName ?? identity.remoteId}", mas esta ` +
            `conta está vinculada a "${target.remoteDisplayName ?? target.remoteId}". ` +
            `Entre na plataforma com o perfil correto e tente de novo.`,
        );
      }

      await prisma.socialAccount.update({
        where: { id: target.id },
        data: { ...identityData, deletedAt: null },
      });

      return { socialAccountId: target.id, reconnected: true };
    }

    if (existingByRemote) {
      if (existingByRemote.deletedAt === null && existingByRemote.status !== 'DISCONNECTED') {
        throw new ConflictError(
          `O perfil "${identity.displayName ?? identity.remoteId}" já está conectado nesta ` +
            `organização como "${existingByRemote.nickname}".`,
        );
      }

      // Reconectar uma conta antes desconectada preserva o histórico de
      // publicações em vez de criar uma conta nova e órfã.
      await prisma.socialAccount.update({
        where: { id: existingByRemote.id },
        data: {
          ...identityData,
          deletedAt: null,
          nickname: payload.nickname,
          clientId: payload.clientId,
          timezone: payload.timezone,
          connectedAt: new Date(),
        },
      });

      this.container.logger.info(
        { socialAccountId: existingByRemote.id, correlationId },
        'conta previamente desconectada foi reativada',
      );

      return { socialAccountId: existingByRemote.id, reconnected: true };
    }

    const created = await prisma.socialAccount.create({
      data: {
        organizationId: payload.organizationId,
        clientId: payload.clientId,
        platform: payload.platform,
        remoteId: identity.remoteId,
        nickname: payload.nickname,
        timezone: payload.timezone,
        connectedAt: new Date(),
        ...identityData,
      },
    });

    return { socialAccountId: created.id, reconnected: false };
  }

  /**
   * Limite de contas do plano (SPEC seção 6: limites nunca hardcoded).
   * Consultado antes de iniciar o fluxo, para o usuário não descobrir o
   * bloqueio depois de já ter autorizado na plataforma.
   */
  async assertAccountLimit(organizationId: string): Promise<void> {
    const subscription = await this.container.prisma.subscription.findUnique({
      where: { organizationId },
      include: { plan: true },
    });
    if (!subscription) return;

    const limits = {
      ...(subscription.plan.limits as Record<string, unknown>),
      ...((subscription.limitOverrides as Record<string, unknown> | null) ?? {}),
    };

    const max = limits['maxSocialAccounts'];
    if (typeof max !== 'number' || max < 0) return; // -1 = ilimitado

    const current = await this.container.prisma.socialAccount.count({
      where: { organizationId, deletedAt: null },
    });

    if (current >= max) {
      throw new ForbiddenError(
        `Seu plano (${subscription.plan.name}) permite até ${max} contas conectadas. ` +
          `Desconecte uma conta ou mude de plano para conectar outra.`,
      );
    }
  }

  private stateKey(state: string): string {
    return `${this.container.env.QUEUE_PREFIX}:oauth:state:${state}`;
  }
}

export type { AdapterContext };
