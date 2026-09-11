import { getPlatformDefinition, type SocialMediaAdapter } from '@app/core';
import { createTikTokAuthenticator } from './auth.js';
import { createTikTokPublisher } from './publisher.js';

/**
 * Adapter do TikTok — Fase 7.
 *
 * Ausências propositais, e o motivo de cada uma:
 *
 *  - `analytics`: as métricas do TikTok vivem na Display API, sob os escopos
 *    `user.info.stats` e `video.list`, que passam por revisão separada e NÃO
 *    estão entre os escopos que este sistema pede
 *    (`oauthScopes` do registro: user.info.basic, video.publish). Declarar
 *    analytics aqui faria a UI prometer números que a autorização atual não
 *    permite buscar.
 *
 *  - `inbox`: mesma razão — comentários dependem de escopos liberados caso a
 *    caso, como o registro já diz em `capabilities.readComments`.
 *
 *  - `webhooks`: não implementado nesta fase. A ausência é o que faz o
 *    endpoint responder 501 em vez de aceitar uma chamada sem verificar
 *    assinatura.
 *
 * Quando algum desses escopos for aprovado para o app, o caminho é
 * implementar o módulo e só então acrescentar a propriedade — nunca o
 * contrário.
 */
export function createTikTokAdapter(): SocialMediaAdapter {
  return {
    platform: 'TIKTOK',
    definition: getPlatformDefinition('TIKTOK'),
    auth: createTikTokAuthenticator(),
    publisher: createTikTokPublisher(),
  };
}
