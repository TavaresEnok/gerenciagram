import { createHash } from 'node:crypto';

/**
 * Idempotência (SPEC seções 2, 6.1 e 12).
 *
 * A chave de um destino é derivada de (post, conta) — determinística, não
 * aleatória. Isso é o que garante que reprocessar um job, reenviar a
 * requisição ou ter dois workers pegando a mesma mensagem nunca publique
 * duas vezes na mesma conta: a segunda tentativa colide com a UNIQUE do
 * banco em vez de virar um segundo post.
 */

export function buildTargetIdempotencyKey(postId: string, socialAccountId: string): string {
  return `pt_${sha256(`${postId}:${socialAccountId}`).slice(0, 40)}`;
}

/**
 * Chave de idempotência de uma requisição de escrita da API própria.
 * O cliente manda `Idempotency-Key`; combinamos com organização e rota para
 * que a mesma chave em contextos diferentes não colida.
 */
export function buildRequestIdempotencyKey(
  organizationId: string,
  route: string,
  clientKey: string,
): string {
  return sha256(`${organizationId}:${route}:${clientKey}`);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
