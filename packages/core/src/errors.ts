/**
 * Hierarquia de erros do domínio.
 *
 * Regra: todo erro que sai de um adapter de plataforma precisa ser
 * classificado como *recuperável* ou *permanente*. O worker usa essa
 * classificação para decidir entre re-tentar e desistir — sem ela, um token
 * revogado consome 5 tentativas de retry à toa e um rate limit temporário é
 * tratado como falha definitiva.
 */

export type ErrorSeverity = 'ERROR' | 'WARNING';

export class DomainError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details?: unknown;

  constructor(code: string, message: string, httpStatus = 400, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
    Error.captureStackTrace?.(this, new.target);
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export class ValidationError extends DomainError {
  constructor(message: string, details?: unknown) {
    super('VALIDATION_ERROR', message, 422, details);
  }
}

export class NotFoundError extends DomainError {
  constructor(entity: string, id?: string) {
    super('NOT_FOUND', id ? `${entity} não encontrado: ${id}` : `${entity} não encontrado`, 404);
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message = 'Não autenticado') {
    super('UNAUTHORIZED', message, 401);
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = 'Você não tem permissão para esta ação') {
    super('FORBIDDEN', message, 403);
  }
}

export class ConflictError extends DomainError {
  constructor(message: string, details?: unknown) {
    super('CONFLICT', message, 409, details);
  }
}

export class RateLimitError extends DomainError {
  readonly retryAfterMs: number;
  constructor(message = 'Limite de requisições excedido', retryAfterMs = 60_000) {
    super('RATE_LIMITED', message, 429, { retryAfterMs });
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * A funcionalidade não existe na API oficial da plataforma.
 *
 * A SPEC (seção 3) exige que isso apareça para o usuário como
 * "Este recurso não está disponível pela API oficial desta plataforma."
 * — nunca simular o comportamento.
 */
export class UnsupportedByPlatformError extends DomainError {
  constructor(platform: string, feature: string) {
    super(
      'UNSUPPORTED_BY_PLATFORM',
      `Este recurso não está disponível pela API oficial desta plataforma (${platform}: ${feature}).`,
      422,
      { platform, feature },
    );
  }
}

/**
 * As credenciais do app (client id/secret) não foram configuradas no ambiente.
 * A UI mostra a rede como "não configurada" em vez de fingir que funciona.
 */
export class PlatformNotConfiguredError extends DomainError {
  constructor(platform: string) {
    super(
      'PLATFORM_NOT_CONFIGURED',
      `A integração com ${platform} ainda não foi configurada neste ambiente. ` +
        `Faltam as credenciais do aplicativo (ver SOCIAL_INTEGRATIONS.md).`,
      503,
      { platform },
    );
  }
}

// ---------------------------------------------------------------------------
//  Erros vindos das plataformas
// ---------------------------------------------------------------------------

export interface PlatformErrorOptions {
  /** Se true, re-tentar depois pode dar certo (5xx, timeout, rate limit). */
  retryable: boolean;
  platform: string;
  httpStatus?: number;
  /** Código de erro da própria plataforma, preservado para diagnóstico. */
  remoteCode?: string;
  retryAfterMs?: number;
  cause?: unknown;
}

export class PlatformApiError extends DomainError {
  readonly retryable: boolean;
  readonly platform: string;
  readonly remoteCode?: string;
  readonly retryAfterMs?: number;

  constructor(message: string, opts: PlatformErrorOptions) {
    super('PLATFORM_API_ERROR', message, 502, {
      platform: opts.platform,
      remoteCode: opts.remoteCode,
      httpStatus: opts.httpStatus,
    });
    this.retryable = opts.retryable;
    this.platform = opts.platform;
    this.remoteCode = opts.remoteCode;
    this.retryAfterMs = opts.retryAfterMs;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

/** Token expirado/revogado: permanente até o usuário reconectar a conta. */
export class TokenExpiredError extends PlatformApiError {
  constructor(platform: string, message = 'Token de acesso expirado ou revogado') {
    super(message, { retryable: false, platform, httpStatus: 401 });
  }
}

/** Timeout de chamada externa: sempre recuperável. */
export class PlatformTimeoutError extends PlatformApiError {
  constructor(platform: string, timeoutMs: number) {
    super(`Tempo esgotado ao chamar a API de ${platform} (${timeoutMs}ms)`, {
      retryable: true,
      platform,
    });
  }
}

/** Circuito aberto — a plataforma está falhando repetidamente. */
export class CircuitOpenError extends DomainError {
  readonly retryAfterMs: number;
  constructor(platform: string, retryAfterMs: number) {
    super(
      'CIRCUIT_OPEN',
      `A integração com ${platform} está temporariamente suspensa por falhas repetidas. ` +
        `Nova tentativa em ${Math.ceil(retryAfterMs / 1000)}s.`,
      503,
      { platform, retryAfterMs },
    );
    this.retryAfterMs = retryAfterMs;
  }
}

/** Cota diária estourada. O worker reagenda em vez de gastar tentativas. */
export class QuotaExceededError extends DomainError {
  readonly resetsAt: Date;
  readonly scope: 'ACCOUNT' | 'APP';

  constructor(platform: string, scope: 'ACCOUNT' | 'APP', resetsAt: Date) {
    super(
      'QUOTA_EXCEEDED',
      scope === 'APP'
        ? `A cota diária do aplicativo em ${platform} foi atingida. ` +
            `Este limite é compartilhado por toda a plataforma.`
        : `A cota diária desta conta em ${platform} foi atingida.`,
      429,
      { platform, scope, resetsAt: resetsAt.toISOString() },
    );
    this.resetsAt = resetsAt;
    this.scope = scope;
  }
}

/**
 * A plataforma proíbe publicar o mesmo conteúdo em várias contas
 * (caso do X). Bloqueia no agendamento, não na hora de publicar.
 */
export class DuplicateContentError extends DomainError {
  constructor(platform: string, policyUrl: string | undefined, conflictingAccounts: string[]) {
    super(
      'DUPLICATE_CONTENT_FORBIDDEN',
      `${platform} proíbe publicar conteúdo igual ou substancialmente semelhante ` +
        `em mais de uma conta. Contas em conflito: ${conflictingAccounts.join(', ')}.`,
      422,
      { platform, policyUrl, conflictingAccounts },
    );
  }
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof PlatformApiError) return error.retryable;
  if (error instanceof RateLimitError) return true;
  if (error instanceof CircuitOpenError) return true;
  if (error instanceof QuotaExceededError) return true;
  // Erros de rede do Node
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return (
      code === 'ECONNRESET' ||
      code === 'ETIMEDOUT' ||
      code === 'ECONNREFUSED' ||
      code === 'EAI_AGAIN' ||
      code === 'EPIPE' ||
      error.name === 'AbortError' ||
      error.name === 'TimeoutError'
    );
  }
  return false;
}
