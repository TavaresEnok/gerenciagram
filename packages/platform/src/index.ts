/**
 * @app/platform — tudo que fala com as redes sociais.
 *
 * Fica num pacote próprio porque API e worker precisam exatamente das mesmas
 * garantias: mesmo adapter, mesma renovação de token, mesma contabilidade de
 * cota, mesmo circuit breaker. Duplicar isso entre os dois processos seria o
 * caminho mais curto para o worker publicar sob uma regra que a API não aplica.
 */

export * from './crypto.js';
export * from './registry.js';
export * from './tokens.js';
export * from './quota.js';
export * from './circuit.js';
export * from './error-reporter.js';

export { createYouTubeAdapter, queryUploadOffset } from './adapters/youtube/index.js';
export { createFacebookAdapter, createInstagramAdapter } from './adapters/meta/index.js';
export { createTikTokAdapter } from './adapters/tiktok/index.js';
export { createXAdapter } from './adapters/x/index.js';
