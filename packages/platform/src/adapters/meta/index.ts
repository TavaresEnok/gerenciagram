import { getPlatformDefinition, type SocialMediaAdapter } from '@app/core';
import { createFacebookAnalytics, createInstagramAnalytics } from './analytics.js';
import { createMetaAuthenticator } from './auth.js';
import { createFacebookPublisher } from './facebook.js';
import { createFacebookInbox, createInstagramInbox } from './inbox.js';
import { createInstagramPublisher } from './instagram.js';
import { createMetaWebhookVerifier } from './webhooks.js';

/**
 * Adapters da Meta — Instagram e Facebook (SPEC Fase 6).
 *
 * São dois adapters distintos porque o núcleo trata cada rede como uma
 * plataforma independente (uma conta de Instagram e uma Página do Facebook
 * são destinos separados, com cotas e regras próprias). O que eles
 * compartilham — cliente HTTP, classificação de erro, OAuth — está em
 * módulos comuns, para não divergir.
 */

export interface MetaOptions {
  apiVersion: string;
  appSecret?: string | undefined;
  /** Token de verificação cadastrado no console da Meta. */
  webhookVerifyToken?: string | undefined;
}

export function createInstagramAdapter(options: MetaOptions): SocialMediaAdapter {
  const adapter: SocialMediaAdapter = {
    platform: 'INSTAGRAM',
    definition: getPlatformDefinition('INSTAGRAM'),
    auth: createMetaAuthenticator('INSTAGRAM', options.apiVersion),
    publisher: createInstagramPublisher(options.apiVersion),
    analytics: createInstagramAnalytics(options.apiVersion),
    inbox: createInstagramInbox(options.apiVersion),
  };

  // O verificador só existe quando há segredo para verificar. Sem ele, o
  // endpoint de webhook responde 501 — aceitar evento não verificado seria
  // uma porta aberta.
  if (options.appSecret && options.webhookVerifyToken) {
    return {
      ...adapter,
      webhooks: createMetaWebhookVerifier(options.appSecret, options.webhookVerifyToken),
    };
  }

  return adapter;
}

export function createFacebookAdapter(options: MetaOptions): SocialMediaAdapter {
  const adapter: SocialMediaAdapter = {
    platform: 'FACEBOOK',
    definition: getPlatformDefinition('FACEBOOK'),
    auth: createMetaAuthenticator('FACEBOOK', options.apiVersion),
    publisher: createFacebookPublisher(options.apiVersion),
    analytics: createFacebookAnalytics(options.apiVersion),
    inbox: createFacebookInbox(options.apiVersion),
  };

  if (options.appSecret && options.webhookVerifyToken) {
    return {
      ...adapter,
      webhooks: createMetaWebhookVerifier(options.appSecret, options.webhookVerifyToken),
    };
  }

  return adapter;
}

export { createMetaWebhookVerifier };
