import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SocialWebhookVerifier } from '@app/core';

/**
 * Verificação de webhook da Meta (SPEC seção 16).
 *
 * A Meta assina o corpo com HMAC-SHA256 usando o **App Secret** e envia o
 * resultado em `X-Hub-Signature-256`, no formato `sha256=<hex>`.
 *
 * Dois cuidados que decidem se isto é segurança ou teatro:
 *
 *  1. o HMAC é calculado sobre o corpo **CRU**. Recalcular sobre o JSON
 *     re-serializado falha, porque a ordem das chaves e o espaçamento mudam;
 *  2. a comparação é em tempo constante. Comparar com `===` vaza, por timing,
 *     quantos bytes iniciais da assinatura estão corretos — o suficiente para
 *     forjar byte a byte.
 */
export function createMetaWebhookVerifier(
  appSecret: string,
  verifyToken: string,
): SocialWebhookVerifier {
  return {
    verifySignature(rawBody: Buffer, headers: Record<string, string | undefined>): boolean {
      const cabecalho = headers['x-hub-signature-256'] ?? headers['X-Hub-Signature-256'];

      if (!cabecalho?.startsWith('sha256=')) return false;

      const esperado = createHmac('sha256', appSecret).update(rawBody).digest();
      const recebido = Buffer.from(cabecalho.slice('sha256='.length), 'hex');

      // timingSafeEqual lança se os tamanhos diferirem — a checagem anterior
      // evita transformar uma assinatura malformada em exceção.
      if (recebido.length !== esperado.length) return false;

      return timingSafeEqual(recebido, esperado);
    },

    /**
     * Desafio de subscrição: a Meta faz um GET com `hub.mode=subscribe` e um
     * token que precisa bater com o que foi cadastrado no console.
     */
    handleSubscriptionChallenge(query: Record<string, string | undefined>): string | null {
      const modo = query['hub.mode'];
      const token = query['hub.verify_token'];
      const desafio = query['hub.challenge'];

      if (modo !== 'subscribe' || !desafio) return null;
      if (!token || token !== verifyToken) return null;

      return desafio;
    },
  };
}
