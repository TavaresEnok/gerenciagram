import {
  PlatformApiError,
  PlatformTimeoutError,
  RateLimitError,
  TokenExpiredError,
  withTimeout,
  type AdapterContext,
} from '@app/core';

/**
 * Camada HTTP da Graph API da Meta, compartilhada por Instagram e Facebook.
 *
 * As duas redes usam o mesmo host, o mesmo formato de erro e o mesmo esquema
 * de token — separar em dois clientes duplicaria a classificação de erro, que
 * é justamente a parte que não pode divergir entre elas.
 */

const PLATFORM = 'Meta';

export interface GraphError {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    error_user_title?: string;
    error_user_msg?: string;
    fbtrace_id?: string;
  };
}

/**
 * Códigos que NÃO adiantam re-tentar.
 * Fonte: https://developers.facebook.com/docs/graph-api/guides/error-handling
 */
const PERMANENTES = new Set([
  100, // parâmetro inválido
  110, // id de usuário inválido
  190, // token inválido/expirado (tratado à parte)
  200, // permissão insuficiente
  210, // usuário não visível
  803, // objeto inexistente
  368, // bloqueado por comportamento abusivo
]);

/**
 * Códigos de limite. A Meta distingue limite do APP (4), do USUÁRIO (17) e
 * de página (32) — todos recuperáveis, mas só depois da janela.
 */
const LIMITES = new Set([4, 17, 32, 613]);

/**
 * Subcódigos de token que exigem RECONEXÃO, não renovação.
 * 458: app removido · 459: usuário no checkpoint · 460: senha trocada ·
 * 463: expirado · 464: usuário não confirmado · 467: token inválido
 */
const RECONEXAO = new Set([458, 459, 460, 463, 464, 467]);

export interface GraphRequestOptions {
  method?: string;
  /** Caminho relativo, ex.: `/{ig-id}/media`. */
  path: string;
  accessToken: string;
  /** Vira querystring em GET e corpo form-urlencoded nas demais. */
  params?: Record<string, string | number | boolean | undefined>;
  ctx: AdapterContext;
  apiVersion: string;
}

export async function graphRequest<T>(options: GraphRequestOptions): Promise<T> {
  const { signal, cancel } = withTimeout(options.ctx.timeoutMs, options.ctx.signal);
  const method = options.method ?? 'GET';

  const entradas = Object.entries(options.params ?? {}).filter(
    ([, valor]) => valor !== undefined,
  );

  const url = new URL(
    `https://graph.facebook.com/${options.apiVersion}${options.path}`,
  );

  let body: string | undefined;

  if (method === 'GET' || method === 'DELETE') {
    for (const [chave, valor] of entradas) url.searchParams.set(chave, String(valor));
  } else {
    const form = new URLSearchParams();
    for (const [chave, valor] of entradas) form.set(chave, String(valor));
    body = form.toString();
  }

  try {
    const resposta = await fetch(url.toString(), {
      method,
      headers: {
        // O token vai no header, não na querystring: URL com token acaba em
        // log de proxy e em histórico de navegador.
        Authorization: `Bearer ${options.accessToken}`,
        Accept: 'application/json',
        ...(body !== undefined
          ? { 'Content-Type': 'application/x-www-form-urlencoded' }
          : {}),
      },
      ...(body !== undefined ? { body } : {}),
      signal,
    });

    const texto = await resposta.text();

    if (!resposta.ok) throw toDomainError(resposta.status, texto);

    return (texto ? JSON.parse(texto) : {}) as T;
  } catch (erro) {
    if (erro instanceof PlatformApiError || erro instanceof RateLimitError) throw erro;

    if (erro instanceof Error && (erro.name === 'AbortError' || erro.name === 'TimeoutError')) {
      throw new PlatformTimeoutError(PLATFORM, options.ctx.timeoutMs);
    }

    throw new PlatformApiError(
      `Falha de rede ao chamar a Graph API: ${erro instanceof Error ? erro.message : String(erro)}`,
      { retryable: true, platform: PLATFORM, cause: erro },
    );
  } finally {
    cancel();
  }
}

/**
 * Traduz o erro da Graph API para o erro de domínio correspondente.
 *
 * A Meta devolve mensagens em dois níveis: `message` (técnica) e
 * `error_user_msg` (escrita para o usuário final). Quando a segunda existe,
 * ela é melhor — foi escrita justamente para ser mostrada.
 */
function toDomainError(status: number, texto: string): Error {
  let payload: GraphError = {};
  try {
    payload = JSON.parse(texto) as GraphError;
  } catch {
    // Resposta sem corpo JSON: seguimos só com o status.
  }

  const erro = payload.error;
  const codigo = erro?.code;
  const subcodigo = erro?.error_subcode;

  const mensagem =
    erro?.error_user_msg ?? erro?.message ?? texto.slice(0, 300) ?? `HTTP ${status}`;

  if (codigo === 190 || (subcodigo !== undefined && RECONEXAO.has(subcodigo))) {
    return new TokenExpiredError(
      PLATFORM,
      `A Meta recusou o token desta conta: ${mensagem}. É preciso reconectar.`,
    );
  }

  if (codigo !== undefined && LIMITES.has(codigo)) {
    // A Meta não informa quando o limite reseta. Uma hora é o intervalo que a
    // própria documentação usa como referência de janela.
    return new RateLimitError(`Limite da Meta atingido (código ${codigo}): ${mensagem}`, 3_600_000);
  }

  if (codigo !== undefined && PERMANENTES.has(codigo)) {
    return new PlatformApiError(`Meta (código ${codigo}): ${mensagem}`, {
      retryable: false,
      platform: PLATFORM,
      httpStatus: status,
      remoteCode: String(codigo),
    });
  }

  if (status >= 500) {
    return new PlatformApiError(`Meta indisponível (${status}): ${mensagem}`, {
      retryable: true,
      platform: PLATFORM,
      httpStatus: status,
    });
  }

  return new PlatformApiError(`Meta (${status}${codigo ? `/${codigo}` : ''}): ${mensagem}`, {
    // 4xx sem código conhecido: tratamos como permanente. Re-tentar um
    // parâmetro inválido cinco vezes só queima tentativa.
    retryable: status >= 500,
    platform: PLATFORM,
    httpStatus: status,
    ...(codigo !== undefined ? { remoteCode: String(codigo) } : {}),
  });
}

/**
 * Espera um contêiner de mídia ficar pronto.
 *
 * A Meta transcodifica de forma assíncrona e a documentação recomenda
 * consultar uma vez por minuto, por no máximo cinco minutos. Publicar antes
 * de `FINISHED` falha.
 */
export async function aguardarContainer(
  containerId: string,
  accessToken: string,
  apiVersion: string,
  ctx: AdapterContext,
  opcoes: { intervaloMs?: number; tentativas?: number } = {},
): Promise<void> {
  const intervalo = opcoes.intervaloMs ?? 10_000;
  const tentativas = opcoes.tentativas ?? 30;

  for (let tentativa = 0; tentativa < tentativas; tentativa += 1) {
    const resposta = await graphRequest<{ status_code?: string; status?: string }>({
      path: `/${containerId}`,
      params: { fields: 'status_code,status' },
      accessToken,
      apiVersion,
      ctx,
    });

    const estado = resposta.status_code;

    if (estado === 'FINISHED') return;

    if (estado === 'ERROR') {
      throw new PlatformApiError(
        `A Meta recusou a mídia durante o processamento: ${resposta.status ?? 'sem detalhe'}`,
        { retryable: false, platform: PLATFORM },
      );
    }

    if (estado === 'EXPIRED') {
      throw new PlatformApiError(
        'O contêiner de mídia expirou antes de ser publicado (limite de 24h da Meta).',
        { retryable: false, platform: PLATFORM },
      );
    }

    await new Promise((resolver) => setTimeout(resolver, intervalo));
  }

  throw new PlatformApiError(
    `A Meta ainda não terminou de processar a mídia após ${(intervalo * tentativas) / 1000}s. ` +
      `O destino será re-tentado.`,
    { retryable: true, platform: PLATFORM },
  );
}
