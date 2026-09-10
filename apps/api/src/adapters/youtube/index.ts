import { getPlatformDefinition, type SocialMediaAdapter } from '@app/core';
import { createYouTubeAnalytics } from './analytics.js';
import { createYouTubeAuthenticator } from './auth.js';
import { createYouTubeInbox } from './inbox.js';
import { createYouTubePublisher } from './publisher.js';

/**
 * Adapter do YouTube — a integração real da Fase 0.
 *
 * Não há `webhooks` aqui: o YouTube não oferece webhook de publicação por API
 * oficial (o PubSubHubbub cobre feed de vídeos novos, que é outro caso de
 * uso). A ausência da propriedade é o jeito de o núcleo saber disso sem
 * precisar perguntar — declarar um verificador vazio seria fingir suporte.
 */
export function createYouTubeAdapter(): SocialMediaAdapter {
  return {
    platform: 'YOUTUBE',
    definition: getPlatformDefinition('YOUTUBE'),
    auth: createYouTubeAuthenticator(),
    publisher: createYouTubePublisher(),
    analytics: createYouTubeAnalytics(),
    inbox: createYouTubeInbox(),
  };
}

export { queryUploadOffset } from './publisher.js';
