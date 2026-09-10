import { randomUUID } from 'node:crypto';
import { ConflictError, ForbiddenError, UnauthorizedError, ValidationError } from '@app/core';
import type { PrismaClient, RoleName } from '@app/db';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import type { Container } from '../../container.js';
import { recordAudit } from '../../lib/audit.js';
import { decrypt, encrypt, generateToken, hashToken, safeCompare } from '@app/platform';
import { signAccessToken, signMfaChallengeToken, verifyMfaChallengeToken } from '../../lib/jwt.js';
import {
  emailVerificationMessage,
  organizationInviteMessage,
  passwordResetMessage,
} from '../../lib/mailer.js';
import { checkPasswordStrength, hashPassword, verifyPassword } from '../../lib/password.js';

/**
 * Regras de autenticação (SPEC seções 1, 5 e 10).
 *
 * Decisões que valem explicação:
 *
 *  - Refresh token é OPACO e guardado como SHA-256, com rotação a cada uso.
 *    Reuso de um token já rotacionado significa que alguém copiou a sessão:
 *    revogamos a família inteira em vez de só recusar aquele token.
 *  - Login não diz se o e-mail existe. "E-mail ou senha incorretos" para os
 *    dois casos; caso contrário o endpoint vira um verificador de cadastro.
 *  - Bloqueio progressivo por tentativas erradas, com janela curta — trava o
 *    ataque de força bruta sem virar um jeito fácil de bloquear a conta alheia.
 */

const MAX_FAILED_LOGINS = 8;
const LOCK_DURATION_MS = 15 * 60_000;
const EMAIL_TOKEN_TTL_MS = 24 * 60 * 60_000;
const RESET_TOKEN_TTL_MS = 60 * 60_000;
const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60_000;

export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
  correlationId: string;
}

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export type LoginResult =
  | { status: 'ok'; tokens: SessionTokens; user: PublicUser; organizationId: string }
  | { status: 'mfa_required'; challengeToken: string }
  | { status: 'no_organization'; tokens: null; user: PublicUser };

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  timezone: string;
  locale: string;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
}

export class AuthService {
  constructor(private readonly container: Container) {}

  private get prisma(): PrismaClient {
    return this.container.prisma;
  }

  // -------------------------------------------------------------------------
  //  Cadastro
  // -------------------------------------------------------------------------

  /**
   * Cria usuário + organização + vínculo de OWNER numa transação.
   *
   * Os três juntos porque uma organização sem dono, ou um usuário sem
   * organização criado por engano, deixam o sistema num estado que nenhuma
   * tela sabe representar.
   */
  async register(input: {
    email: string;
    password: string;
    name: string;
    organizationName: string;
    timezone?: string;
    meta: RequestMeta;
  }): Promise<{ user: PublicUser; organizationId: string }> {
    const email = normalizeEmail(input.email);

    const strength = checkPasswordStrength(input.password, email);
    if (!strength.ok) {
      throw new ValidationError('A senha não atende à política de segurança.', {
        problems: strength.problems,
      });
    }

    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictError('Já existe uma conta com este e-mail.');
    }

    const passwordHash = await hashPassword(input.password);
    const slug = await this.uniqueOrganizationSlug(input.organizationName);
    const timezone = input.timezone ?? 'America/Sao_Paulo';

    const freePlan = await this.prisma.plan.findUnique({ where: { tier: 'FREE' } });

    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email, name: input.name.trim(), passwordHash, timezone },
      });

      const organization = await tx.organization.create({
        data: { name: input.organizationName.trim(), slug, timezone },
      });

      await tx.membership.create({
        data: {
          organizationId: organization.id,
          userId: user.id,
          role: 'OWNER',
          status: 'ACTIVE',
          acceptedAt: new Date(),
        },
      });

      if (freePlan) {
        await tx.subscription.create({
          data: { organizationId: organization.id, planId: freePlan.id, status: 'TRIALING' },
        });
      }

      return { user, organization };
    });

    // Falha no envio NÃO derruba o cadastro: a conta já existe e o usuário
    // pode pedir o reenvio. Perder a conta porque o SMTP piscou seria pior.
    try {
      await this.sendEmailVerification(email);
    } catch (error) {
      this.container.logger.error(
        { err: error, correlationId: input.meta.correlationId },
        'não foi possível enviar o e-mail de verificação no cadastro',
      );
    }

    await recordAudit(this.prisma, {
      organizationId: result.organization.id,
      actorUserId: result.user.id,
      action: 'auth.register',
      entityType: 'User',
      entityId: result.user.id,
      changes: { email, organizationName: result.organization.name },
      ipAddress: input.meta.ipAddress ?? null,
      userAgent: input.meta.userAgent ?? null,
      correlationId: input.meta.correlationId,
    });

    return { user: toPublicUser(result.user), organizationId: result.organization.id };
  }

  // -------------------------------------------------------------------------
  //  Login
  // -------------------------------------------------------------------------

  async login(input: {
    email: string;
    password: string;
    organizationId?: string;
    meta: RequestMeta;
  }): Promise<LoginResult> {
    const email = normalizeEmail(input.email);

    const user = await this.prisma.user.findUnique({
      where: { email },
      include: {
        memberships: {
          where: { status: 'ACTIVE', deletedAt: null, organization: { deletedAt: null } },
          include: { organization: { select: { id: true, name: true, slug: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    // Hash falso quando o usuário não existe: sem isto, a diferença de tempo
    // entre "e-mail inexistente" e "senha errada" entrega quais e-mails têm conta.
    if (!user || !user.passwordHash) {
      await verifyPassword(
        '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRoZXJl$0000000000000000000000000000000000000000000',
        input.password,
      );
      throw new UnauthorizedError('E-mail ou senha incorretos.');
    }

    if (user.deletedAt) {
      throw new UnauthorizedError('E-mail ou senha incorretos.');
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
      throw new UnauthorizedError(
        `Muitas tentativas incorretas. Tente novamente em ${minutes} minuto(s).`,
      );
    }

    const valid = await verifyPassword(user.passwordHash, input.password);

    if (!valid) {
      await this.registerFailedLogin(user.id, user.failedLoginCount);
      throw new UnauthorizedError('E-mail ou senha incorretos.');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    // Segundo fator antes de emitir qualquer token de sessão.
    if (user.twoFactorEnabled && user.twoFactorConfirmedAt) {
      const challengeToken = await signMfaChallengeToken(
        user.id,
        this.container.env.JWT_ACCESS_SECRET,
      );
      return { status: 'mfa_required', challengeToken };
    }

    return this.completeLogin(user.id, input.organizationId, false, input.meta);
  }

  async verifyMfaAndLogin(input: {
    challengeToken: string;
    code: string;
    organizationId?: string;
    meta: RequestMeta;
  }): Promise<LoginResult> {
    let userId: string;
    try {
      userId = await verifyMfaChallengeToken(
        input.challengeToken,
        this.container.env.JWT_ACCESS_SECRET,
      );
    } catch {
      throw new UnauthorizedError('Desafio de verificação expirado. Faça login novamente.');
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.twoFactorSecret) {
      throw new UnauthorizedError('Autenticação de dois fatores não está configurada.');
    }

    const accepted = await this.consumeTotpOrRecoveryCode(user.id, user.twoFactorSecret, user.twoFactorRecoveryCodes, input.code);
    if (!accepted) {
      await this.registerFailedLogin(user.id, user.failedLoginCount);
      throw new UnauthorizedError('Código de verificação inválido.');
    }

    return this.completeLogin(user.id, input.organizationId, true, input.meta);
  }

  private async completeLogin(
    userId: string,
    requestedOrganizationId: string | undefined,
    mfaSatisfied: boolean,
    meta: RequestMeta,
  ): Promise<LoginResult> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: {
        memberships: {
          where: { status: 'ACTIVE', deletedAt: null, organization: { deletedAt: null } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    const membership = requestedOrganizationId
      ? user.memberships.find((m) => m.organizationId === requestedOrganizationId)
      : user.memberships[0];

    if (!membership) {
      if (requestedOrganizationId) {
        throw new ForbiddenError('Você não faz parte desta organização.');
      }
      // Conta válida sem organização ativa: acontece quando o convite foi
      // revogado. Devolvemos o usuário para a UI explicar, em vez de 500.
      return { status: 'no_organization', tokens: null, user: toPublicUser(user) };
    }

    const tokens = await this.issueSession({
      userId: user.id,
      organizationId: membership.organizationId,
      role: membership.role,
      scopedClientIds: membership.scopedClientIds,
      mfaSatisfied,
      meta,
    });

    await recordAudit(this.prisma, {
      organizationId: membership.organizationId,
      actorUserId: user.id,
      action: 'auth.login',
      entityType: 'User',
      entityId: user.id,
      changes: { mfaSatisfied },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
      correlationId: meta.correlationId,
    });

    return {
      status: 'ok',
      tokens,
      user: toPublicUser(user),
      organizationId: membership.organizationId,
    };
  }

  private async registerFailedLogin(userId: string, currentCount: number): Promise<void> {
    const failedLoginCount = currentCount + 1;
    const shouldLock = failedLoginCount >= MAX_FAILED_LOGINS;

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        failedLoginCount: shouldLock ? 0 : failedLoginCount,
        lockedUntil: shouldLock ? new Date(Date.now() + LOCK_DURATION_MS) : null,
      },
    });
  }

  // -------------------------------------------------------------------------
  //  Sessão
  // -------------------------------------------------------------------------

  private async issueSession(input: {
    userId: string;
    organizationId: string;
    role: RoleName;
    scopedClientIds: string[];
    mfaSatisfied: boolean;
    meta: RequestMeta;
    familyId?: string;
  }): Promise<SessionTokens> {
    const { env } = this.container;

    const accessToken = await signAccessToken(
      {
        userId: input.userId,
        organizationId: input.organizationId,
        role: input.role,
        scopedClientIds: input.scopedClientIds,
        mfaSatisfied: input.mfaSatisfied,
      },
      env.JWT_ACCESS_SECRET,
      env.ACCESS_TOKEN_TTL,
    );

    const refreshToken = generateToken(48);

    await this.prisma.session.create({
      data: {
        userId: input.userId,
        refreshTokenHash: hashToken(refreshToken),
        familyId: input.familyId ?? randomUUID(),
        expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL * 1000),
        ipAddress: input.meta.ipAddress ?? null,
        userAgent: input.meta.userAgent?.slice(0, 500) ?? null,
      },
    });

    return { accessToken, refreshToken, expiresIn: env.ACCESS_TOKEN_TTL };
  }

  /**
   * Rotação de refresh token com detecção de reuso.
   *
   * Um refresh já rotacionado sendo apresentado de novo só acontece em dois
   * casos: cliente com bug ou token roubado. Como não dá para distinguir,
   * tratamos como comprometimento e derrubamos a família inteira de sessões.
   */
  async refresh(input: {
    refreshToken: string;
    organizationId?: string;
    meta: RequestMeta;
  }): Promise<SessionTokens> {
    const tokenHash = hashToken(input.refreshToken);

    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: tokenHash },
      include: { user: { select: { id: true, deletedAt: true } } },
    });

    if (!session) {
      throw new UnauthorizedError('Sessão inválida. Entre novamente.');
    }

    if (session.rotatedAt !== null || session.revokedAt !== null) {
      await this.prisma.session.updateMany({
        where: { familyId: session.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      this.container.logger.warn(
        { userId: session.userId, familyId: session.familyId, correlationId: input.meta.correlationId },
        'refresh token reutilizado — família de sessões revogada',
      );

      await recordAudit(this.prisma, {
        actorUserId: session.userId,
        action: 'auth.refresh_reuse_detected',
        entityType: 'Session',
        entityId: session.id,
        ipAddress: input.meta.ipAddress ?? null,
        userAgent: input.meta.userAgent ?? null,
        correlationId: input.meta.correlationId,
      });

      throw new UnauthorizedError(
        'Sua sessão foi encerrada por segurança. Entre novamente.',
      );
    }

    if (session.expiresAt < new Date() || session.user.deletedAt !== null) {
      throw new UnauthorizedError('Sessão expirada. Entre novamente.');
    }

    const memberships = await this.prisma.membership.findMany({
      where: {
        userId: session.userId,
        status: 'ACTIVE',
        deletedAt: null,
        organization: { deletedAt: null },
      },
      orderBy: { createdAt: 'asc' },
    });

    const membership = input.organizationId
      ? memberships.find((m) => m.organizationId === input.organizationId)
      : memberships[0];

    if (!membership) {
      throw new UnauthorizedError('Seu acesso a esta organização não está mais ativo.');
    }

    await this.prisma.session.update({
      where: { id: session.id },
      data: { rotatedAt: new Date() },
    });

    return this.issueSession({
      userId: session.userId,
      organizationId: membership.organizationId,
      role: membership.role,
      scopedClientIds: membership.scopedClientIds,
      // O 2FA já satisfeito continua valendo dentro da mesma família.
      mfaSatisfied: true,
      meta: input.meta,
      familyId: session.familyId,
    });
  }

  async logout(refreshToken: string, meta: RequestMeta): Promise<void> {
    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: hashToken(refreshToken) },
    });
    if (!session) return;

    // Revoga a família toda: "sair" significa sair, não só invalidar o
    // último token da cadeia.
    await this.prisma.session.updateMany({
      where: { familyId: session.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await recordAudit(this.prisma, {
      actorUserId: session.userId,
      action: 'auth.logout',
      entityType: 'Session',
      entityId: session.id,
      correlationId: meta.correlationId,
    });
  }

  async logoutAllSessions(userId: string, meta: RequestMeta): Promise<number> {
    const result = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await recordAudit(this.prisma, {
      actorUserId: userId,
      action: 'auth.logout_all',
      entityType: 'User',
      entityId: userId,
      changes: { sessionsRevoked: result.count },
      correlationId: meta.correlationId,
    });

    return result.count;
  }

  // -------------------------------------------------------------------------
  //  Verificação de e-mail e reset de senha
  // -------------------------------------------------------------------------

  async sendEmailVerification(email: string): Promise<void> {
    const token = generateToken();

    await this.prisma.verificationToken.create({
      data: {
        tokenHash: hashToken(token),
        purpose: 'EMAIL_VERIFICATION',
        email: normalizeEmail(email),
        expiresAt: new Date(Date.now() + EMAIL_TOKEN_TTL_MS),
      },
    });

    const url = `${this.container.env.WEB_PUBLIC_URL}/verificar-email?token=${token}`;
    await this.container.mailer.send(emailVerificationMessage(email, url));
  }

  async verifyEmail(token: string): Promise<void> {
    const record = await this.consumeVerificationToken(token, 'EMAIL_VERIFICATION');

    await this.prisma.user.updateMany({
      where: { email: record.email, emailVerified: null },
      data: { emailVerified: new Date() },
    });
  }

  /**
   * Sempre responde igual, exista o e-mail ou não. Um endpoint de reset que
   * responde "e-mail não encontrado" é um verificador de cadastro público.
   */
  async requestPasswordReset(email: string): Promise<void> {
    const normalized = normalizeEmail(email);
    const user = await this.prisma.user.findUnique({ where: { email: normalized } });

    if (!user || user.deletedAt) return;

    const token = generateToken();
    await this.prisma.verificationToken.create({
      data: {
        tokenHash: hashToken(token),
        purpose: 'PASSWORD_RESET',
        email: normalized,
        expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      },
    });

    const url = `${this.container.env.WEB_PUBLIC_URL}/redefinir-senha?token=${token}`;
    await this.container.mailer.send(passwordResetMessage(normalized, url));
  }

  async resetPassword(token: string, newPassword: string, meta: RequestMeta): Promise<void> {
    const record = await this.consumeVerificationToken(token, 'PASSWORD_RESET');

    const strength = checkPasswordStrength(newPassword, record.email);
    if (!strength.ok) {
      throw new ValidationError('A senha não atende à política de segurança.', {
        problems: strength.problems,
      });
    }

    const user = await this.prisma.user.findUnique({ where: { email: record.email } });
    if (!user) throw new UnauthorizedError('Não foi possível redefinir a senha.');

    const passwordHash = await hashPassword(newPassword);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
      }),
      // Trocar a senha derruba todas as sessões: se o motivo da troca foi
      // invasão, deixar a sessão do invasor viva anula o efeito.
      this.prisma.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    await recordAudit(this.prisma, {
      actorUserId: user.id,
      action: 'auth.password_reset',
      entityType: 'User',
      entityId: user.id,
      ipAddress: meta.ipAddress ?? null,
      correlationId: meta.correlationId,
    });
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    meta: RequestMeta,
  ): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.passwordHash || !(await verifyPassword(user.passwordHash, currentPassword))) {
      throw new UnauthorizedError('Senha atual incorreta.');
    }

    const strength = checkPasswordStrength(newPassword, user.email);
    if (!strength.ok) {
      throw new ValidationError('A senha não atende à política de segurança.', {
        problems: strength.problems,
      });
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(newPassword) },
    });

    await recordAudit(this.prisma, {
      actorUserId: userId,
      action: 'auth.password_change',
      entityType: 'User',
      entityId: userId,
      correlationId: meta.correlationId,
    });
  }

  private async consumeVerificationToken(
    token: string,
    purpose: string,
  ): Promise<{ email: string; payload: unknown }> {
    const record = await this.prisma.verificationToken.findUnique({
      where: { tokenHash: hashToken(token) },
    });

    if (!record || record.purpose !== purpose) {
      throw new UnauthorizedError('Link inválido.');
    }
    if (record.usedAt) {
      throw new UnauthorizedError('Este link já foi utilizado.');
    }
    if (record.expiresAt < new Date()) {
      throw new UnauthorizedError('Este link expirou. Solicite um novo.');
    }

    await this.prisma.verificationToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    });

    return { email: record.email, payload: record.payload };
  }

  // -------------------------------------------------------------------------
  //  Convites
  // -------------------------------------------------------------------------

  async inviteMember(input: {
    organizationId: string;
    inviterUserId: string;
    email: string;
    role: RoleName;
    scopedClientIds: string[];
    meta: RequestMeta;
  }): Promise<void> {
    const email = normalizeEmail(input.email);

    const [organization, inviter] = await Promise.all([
      this.prisma.organization.findUniqueOrThrow({
        where: { id: input.organizationId },
        select: { name: true },
      }),
      this.prisma.user.findUniqueOrThrow({
        where: { id: input.inviterUserId },
        select: { name: true },
      }),
    ]);

    const existingUser = await this.prisma.user.findUnique({ where: { email } });

    if (existingUser) {
      const existingMembership = await this.prisma.membership.findUnique({
        where: {
          organizationId_userId: {
            organizationId: input.organizationId,
            userId: existingUser.id,
          },
        },
      });
      if (existingMembership && existingMembership.deletedAt === null) {
        throw new ConflictError('Esta pessoa já faz parte da organização.');
      }
    }

    const token = generateToken();
    await this.prisma.verificationToken.create({
      data: {
        tokenHash: hashToken(token),
        purpose: 'ORG_INVITE',
        email,
        payload: {
          organizationId: input.organizationId,
          role: input.role,
          scopedClientIds: input.scopedClientIds,
        },
        expiresAt: new Date(Date.now() + INVITE_TOKEN_TTL_MS),
      },
    });

    const url = `${this.container.env.WEB_PUBLIC_URL}/convite?token=${token}`;
    await this.container.mailer.send(
      organizationInviteMessage(email, organization.name, inviter.name, url),
    );

    await recordAudit(this.prisma, {
      organizationId: input.organizationId,
      actorUserId: input.inviterUserId,
      action: 'org.member_invited',
      entityType: 'Membership',
      changes: { email, role: input.role },
      correlationId: input.meta.correlationId,
    });
  }

  async acceptInvite(input: {
    token: string;
    name?: string;
    password?: string;
    meta: RequestMeta;
  }): Promise<{ organizationId: string; userId: string }> {
    const record = await this.consumeVerificationToken(input.token, 'ORG_INVITE');
    const payload = record.payload as {
      organizationId: string;
      role: RoleName;
      scopedClientIds: string[];
    };

    let user = await this.prisma.user.findUnique({ where: { email: record.email } });

    if (!user) {
      if (!input.password || !input.name) {
        throw new ValidationError(
          'Informe nome e senha para criar sua conta a partir do convite.',
        );
      }
      const strength = checkPasswordStrength(input.password, record.email);
      if (!strength.ok) {
        throw new ValidationError('A senha não atende à política de segurança.', {
          problems: strength.problems,
        });
      }

      user = await this.prisma.user.create({
        data: {
          email: record.email,
          name: input.name.trim(),
          passwordHash: await hashPassword(input.password),
          // O convite chegou no e-mail: clicar nele já prova o endereço.
          emailVerified: new Date(),
        },
      });
    }

    await this.prisma.membership.upsert({
      where: {
        organizationId_userId: { organizationId: payload.organizationId, userId: user.id },
      },
      create: {
        organizationId: payload.organizationId,
        userId: user.id,
        role: payload.role,
        scopedClientIds: payload.scopedClientIds,
        status: 'ACTIVE',
        acceptedAt: new Date(),
      },
      update: {
        role: payload.role,
        scopedClientIds: payload.scopedClientIds,
        status: 'ACTIVE',
        deletedAt: null,
        acceptedAt: new Date(),
      },
    });

    await recordAudit(this.prisma, {
      organizationId: payload.organizationId,
      actorUserId: user.id,
      action: 'org.invite_accepted',
      entityType: 'Membership',
      changes: { role: payload.role },
      correlationId: input.meta.correlationId,
    });

    return { organizationId: payload.organizationId, userId: user.id };
  }

  // -------------------------------------------------------------------------
  //  2FA (TOTP)
  // -------------------------------------------------------------------------

  /**
   * Gera o segredo mas NÃO ativa o 2FA. A ativação só acontece depois que o
   * usuário prova que o app dele gera o código certo — caso contrário é fácil
   * ficar trancado para fora por um QR code que nunca foi escaneado.
   */
  async beginTwoFactorSetup(userId: string): Promise<{ secret: string; qrCodeDataUrl: string; otpauthUrl: string }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });

    if (user.twoFactorEnabled && user.twoFactorConfirmedAt) {
      throw new ConflictError('A autenticação de dois fatores já está ativa.');
    }

    const secret = authenticator.generateSecret();
    const otpauthUrl = authenticator.keyuri(
      user.email,
      this.container.env.TOTP_ISSUER,
      secret,
    );

    const encrypted = encrypt(secret, this.container.keyring);

    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorSecret: encrypted.ciphertext, twoFactorConfirmedAt: null },
    });

    return {
      secret,
      otpauthUrl,
      qrCodeDataUrl: await QRCode.toDataURL(otpauthUrl),
    };
  }

  async confirmTwoFactorSetup(
    userId: string,
    code: string,
    meta: RequestMeta,
  ): Promise<{ recoveryCodes: string[] }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.twoFactorSecret) {
      throw new ValidationError('Inicie a configuração do 2FA antes de confirmar.');
    }

    const secret = decrypt(user.twoFactorSecret, this.container.keyring);
    if (!authenticator.verify({ token: code.replace(/\s/g, ''), secret })) {
      throw new UnauthorizedError('Código inválido. Confira o horário do seu dispositivo.');
    }

    // Códigos de recuperação guardados como hash: quem lê o banco não
    // consegue usá-los para entrar.
    const recoveryCodes = Array.from({ length: 10 }, () => generateToken(6));
    const hashed = recoveryCodes.map((code) => hashToken(code));

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorEnabled: true,
        twoFactorConfirmedAt: new Date(),
        twoFactorRecoveryCodes: hashed,
      },
    });

    await recordAudit(this.prisma, {
      actorUserId: userId,
      action: 'auth.2fa_enabled',
      entityType: 'User',
      entityId: userId,
      correlationId: meta.correlationId,
    });

    return { recoveryCodes };
  }

  async disableTwoFactor(userId: string, password: string, meta: RequestMeta): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });

    if (!user.passwordHash || !(await verifyPassword(user.passwordHash, password))) {
      throw new UnauthorizedError('Senha incorreta.');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorEnabled: false,
        twoFactorSecret: null,
        twoFactorConfirmedAt: null,
        twoFactorRecoveryCodes: [],
      },
    });

    await recordAudit(this.prisma, {
      actorUserId: userId,
      action: 'auth.2fa_disabled',
      entityType: 'User',
      entityId: userId,
      correlationId: meta.correlationId,
    });
  }

  private async consumeTotpOrRecoveryCode(
    userId: string,
    encryptedSecret: string,
    recoveryHashes: string[],
    code: string,
  ): Promise<boolean> {
    const cleaned = code.replace(/\s/g, '');
    const secret = decrypt(encryptedSecret, this.container.keyring);

    if (authenticator.verify({ token: cleaned, secret })) return true;

    // Código de recuperação: uso único, some da lista depois de usado.
    const providedHash = hashToken(cleaned);
    const match = recoveryHashes.find((stored) => safeCompare(stored, providedHash));
    if (!match) return false;

    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorRecoveryCodes: recoveryHashes.filter((h) => h !== match) },
    });

    return true;
  }

  // -------------------------------------------------------------------------

  private async uniqueOrganizationSlug(name: string): Promise<string> {
    const base =
      name
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40) || 'organizacao';

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const slug = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const existing = await this.prisma.organization.findUnique({ where: { slug } });
      if (!existing) return slug;
    }

    return `${base}-${generateToken(4)}`;
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function toPublicUser(user: {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  timezone: string;
  locale: string;
  emailVerified: Date | null;
  twoFactorEnabled: boolean;
}): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    timezone: user.timezone,
    locale: user.locale,
    emailVerified: user.emailVerified !== null,
    twoFactorEnabled: user.twoFactorEnabled,
  };
}
