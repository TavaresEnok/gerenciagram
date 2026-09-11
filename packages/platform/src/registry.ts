import {
  hasCredentials,
  listPlatformDefinitions,
  type AdapterRegistry,
  type AppCredentials,
  type PlatformKey,
  type SocialMediaAdapter,
} from '@app/core';
import { PlatformNotConfiguredError } from '@app/core';
import { createFacebookAdapter, createInstagramAdapter } from './adapters/meta/index.js';
import { createYouTubeAdapter } from './adapters/youtube/index.js';

/**
 * Registro de adapters, compartilhado por API e worker.
 *
 * Só entra aqui a plataforma que TEM implementação. Uma rede declarada mas
 * ainda não implementada não ganha um adapter vazio que finge publicar —
 * pedir por ela resulta em erro explícito (SPEC seção 19).
 */

export interface PlatformEnv {
  OAUTH_PUBLIC_URL: string;
  META_API_VERSION?: string | undefined;
  /** Token do desafio de subscrição de webhook, cadastrado no console. */
  META_WEBHOOK_VERIFY_TOKEN?: string | undefined;
  YOUTUBE_CLIENT_ID?: string | undefined;
  YOUTUBE_CLIENT_SECRET?: string | undefined;
  META_APP_ID?: string | undefined;
  META_APP_SECRET?: string | undefined;
  TIKTOK_CLIENT_KEY?: string | undefined;
  TIKTOK_CLIENT_SECRET?: string | undefined;
  X_CLIENT_ID?: string | undefined;
  X_CLIENT_SECRET?: string | undefined;
  KWAI_CLIENT_ID?: string | undefined;
  KWAI_CLIENT_SECRET?: string | undefined;
}

export interface PlatformServices {
  adapters: AdapterRegistry;
  /** Plataformas implementadas E com credenciais preenchidas neste ambiente. */
  configuredPlatforms: Set<PlatformKey>;
  /** Credenciais do APLICATIVO para uma plataforma. */
  appCredentials(platform: PlatformKey): AppCredentials;
}

export function createPlatformServices(env: PlatformEnv): PlatformServices {
  const implemented = new Map<PlatformKey, SocialMediaAdapter>();

  implemented.set('YOUTUBE', createYouTubeAdapter());

  // Instagram e Facebook compartilham a Graph API, mas são plataformas
  // distintas para o núcleo: uma conta do Instagram e uma Página do Facebook
  // são destinos separados, com cota e regras próprias.
  const meta = {
    apiVersion: env.META_API_VERSION ?? 'v21.0',
    appSecret: env.META_APP_SECRET,
    webhookVerifyToken: env.META_WEBHOOK_VERIFY_TOKEN,
  };

  implemented.set('INSTAGRAM', createInstagramAdapter(meta));
  implemented.set('FACEBOOK', createFacebookAdapter(meta));

  const configuredPlatforms = new Set<PlatformKey>();
  for (const def of listPlatformDefinitions()) {
    if (
      def.isAvailable &&
      implemented.has(def.key) &&
      hasCredentials(def, env as unknown as NodeJS.ProcessEnv)
    ) {
      configuredPlatforms.add(def.key);
    }
  }

  const adapters: AdapterRegistry = {
    get(platform) {
      const adapter = implemented.get(platform);
      if (!adapter) {
        throw new PlatformNotConfiguredError(platform);
      }
      return adapter;
    },
    has: (platform) => implemented.has(platform),
    list: () => [...implemented.values()],
  };

  return {
    adapters,
    configuredPlatforms,

    appCredentials(platform: PlatformKey): AppCredentials {
      const pair = CREDENTIAL_KEYS[platform];
      const clientId = env[pair.id];
      const clientSecret = env[pair.secret];

      if (!clientId || !clientSecret) {
        throw new PlatformNotConfiguredError(platform);
      }

      return {
        clientId,
        clientSecret,
        // A URI de callback precisa bater EXATAMENTE com a cadastrada no
        // console da plataforma — inclusive esquema, porta e barra final.
        redirectUri: buildRedirectUri(env.OAUTH_PUBLIC_URL, platform),
      };
    },
  };
}

const CREDENTIAL_KEYS: Record<
  PlatformKey,
  { id: keyof PlatformEnv; secret: keyof PlatformEnv }
> = {
  YOUTUBE: { id: 'YOUTUBE_CLIENT_ID', secret: 'YOUTUBE_CLIENT_SECRET' },
  INSTAGRAM: { id: 'META_APP_ID', secret: 'META_APP_SECRET' },
  FACEBOOK: { id: 'META_APP_ID', secret: 'META_APP_SECRET' },
  TIKTOK: { id: 'TIKTOK_CLIENT_KEY', secret: 'TIKTOK_CLIENT_SECRET' },
  X: { id: 'X_CLIENT_ID', secret: 'X_CLIENT_SECRET' },
  KWAI: { id: 'KWAI_CLIENT_ID', secret: 'KWAI_CLIENT_SECRET' },
};

export function buildRedirectUri(publicUrl: string, platform: PlatformKey): string {
  return `${publicUrl.replace(/\/$/, '')}/v1/oauth/${platform.toLowerCase()}/callback`;
}
