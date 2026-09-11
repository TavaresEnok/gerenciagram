import { getPlatformDefinition, type SocialMediaAdapter } from '@app/core';
import { createXAuthenticator } from './auth.js';
import { createXPublisher } from './publisher.js';

/**
 * Adapter oficial para o X (Twitter) — Fase 9.
 *
 * Provê:
 *  - Autenticação OAuth 2.0 PKCE (`tweet.read`, `tweet.write`, `users.read`, `offline.access`)
 *  - Publicação de tweets com texto e mídias (imagens/vídeo)
 *  - Exclusão de tweets via API v2
 *
 * Ausências propositais:
 *  - `analytics`: métricas detalhadas de engajamento do X exigem contratação de planos superiores
 *  - `inbox`: mensagens diretas (DMs) exigem escopos e plano corporativo dedicados
 */
export function createXAdapter(): SocialMediaAdapter {
  return {
    platform: 'X',
    definition: getPlatformDefinition('X'),
    auth: createXAuthenticator(),
    publisher: createXPublisher(),
  };
}
