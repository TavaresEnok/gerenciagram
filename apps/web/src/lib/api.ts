'use client';

/**
 * Cliente da API.
 *
 * Decisões que sustentam a segurança do front (SPEC seção 10):
 *
 *  - o ACCESS TOKEN vive só em memória. Guardá-lo em localStorage o
 *    entregaria a qualquer XSS; em memória, ele morre com a aba.
 *  - o REFRESH TOKEN nunca é visto pelo JavaScript: viaja num cookie
 *    httpOnly que o navegador manda sozinho para /v1/auth.
 *  - uma resposta 401 dispara UMA renovação compartilhada por todas as
 *    requisições em voo, que são então repetidas. Sem esse compartilhamento,
 *    uma tela com seis chamadas paralelas dispararia seis renovações e a
 *    detecção de reuso de token derrubaria a sessão.
 */

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';

let accessToken: string | null = null;
let refreshPromise: Promise<boolean> | null = null;

type Listener = (autenticado: boolean) => void;
const listeners = new Set<Listener>();

export function definirToken(token: string | null): void {
  accessToken = token;
  for (const listener of listeners) listener(token !== null);
}

export function obterToken(): string | null {
  return accessToken;
}

export function aoMudarAutenticacao(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly correlationId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Problemas de validação por campo, no formato que os formulários usam. */
  get problemasPorCampo(): Record<string, string> {
    const resultado: Record<string, string> = {};
    if (Array.isArray(this.details)) {
      for (const item of this.details as Array<{ path?: string; message?: string }>) {
        if (item.path) resultado[item.path] = item.message ?? 'valor inválido';
      }
    }
    return resultado;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Chave de idempotência para operações de escrita (SPEC seção 2). */
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** multipart/form-data: o body vai cru, sem JSON.stringify. */
  formData?: FormData;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const resposta = await executar(path, options);

  if (resposta.status === 401 && !path.startsWith('/v1/auth/')) {
    const renovou = await renovarSessao();
    if (renovou) {
      const segunda = await executar(path, options);
      return interpretar<T>(segunda);
    }
    definirToken(null);
  }

  return interpretar<T>(resposta);
}

async function executar(path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };

  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

  let body: BodyInit | undefined;
  if (options.formData) {
    // Sem Content-Type: o navegador precisa gerar o boundary do multipart.
    body = options.formData;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  return fetch(`${API_URL}${path}`, {
    method: options.method ?? (body ? 'POST' : 'GET'),
    headers,
    ...(body !== undefined ? { body } : {}),
    // Necessário para o cookie httpOnly do refresh acompanhar a requisição.
    credentials: 'include',
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

async function interpretar<T>(resposta: Response): Promise<T> {
  if (resposta.status === 204) return undefined as T;

  const texto = await resposta.text();
  const dados = texto ? (JSON.parse(texto) as unknown) : null;

  if (!resposta.ok) {
    const erro = (dados as { error?: { code?: string; message?: string; details?: unknown; correlationId?: string } })
      ?.error;

    throw new ApiError(
      resposta.status,
      erro?.code ?? 'UNKNOWN',
      erro?.message ?? `Erro ${resposta.status}`,
      erro?.details,
      erro?.correlationId,
    );
  }

  return dados as T;
}

/**
 * Renovação compartilhada: várias requisições que tomam 401 ao mesmo tempo
 * esperam a MESMA promessa.
 */
async function renovarSessao(): Promise<boolean> {
  refreshPromise ??= (async () => {
    try {
      const resposta = await fetch(`${API_URL}/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        credentials: 'include',
      });

      if (!resposta.ok) return false;

      const dados = (await resposta.json()) as { accessToken: string };
      definirToken(dados.accessToken);
      return true;
    } catch {
      return false;
    } finally {
      // Libera para a próxima renovação só depois de concluída.
      setTimeout(() => {
        refreshPromise = null;
      }, 0);
    }
  })();

  return refreshPromise;
}

/** Tenta restaurar a sessão a partir do cookie ao abrir a aplicação. */
export async function restaurarSessao(): Promise<boolean> {
  return renovarSessao();
}

export async function sair(): Promise<void> {
  await fetch(`${API_URL}/v1/auth/logout`, { method: 'POST', credentials: 'include' }).catch(
    () => undefined,
  );
  definirToken(null);
}

export { API_URL };
