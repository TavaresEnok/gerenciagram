import { PLATFORM_REGISTRY } from '@app/core';
import { describe, expect, it } from 'vitest';
import { createTikTokAdapter } from './index.js';

describe('TikTok adapter — contrato e registro', () => {
  const adapter = createTikTokAdapter();

  it('bate com o registro da plataforma', () => {
    expect(adapter.platform).toBe('TIKTOK');
    expect(adapter.definition.key).toBe('TIKTOK');
    expect(PLATFORM_REGISTRY.TIKTOK.isAvailable).toBe(true);
    expect(PLATFORM_REGISTRY.TIKTOK.unavailableReason).toBeNull();
  });

  it('declara publicador e autenticador, mas não analytics nem inbox na v1', () => {
    expect(adapter.auth).toBeDefined();
    expect(adapter.publisher).toBeDefined();
    expect(adapter.analytics).toBeUndefined();
    expect(adapter.inbox).toBeUndefined();
    expect(adapter.webhooks).toBeUndefined();
  });
});

describe('TikTok OAuth (Login Kit v2)', () => {
  const adapter = createTikTokAdapter();
  const app = {
    clientId: 'chave_tiktok_app_123',
    clientSecret: 'segredo_tiktok_456',
    redirectUri: 'https://exemplo.com/v1/oauth/tiktok/callback',
  };

  it('monta a URL com client_key (NÃO client_id), PKCE e escopos separados por vírgula', () => {
    const urlString = adapter.auth.buildAuthorizationUrl(app, {
      scopes: ['user.info.basic', 'video.publish'],
      state: 'estado_aleatorio_789',
      codeChallenge: 'desafio_pkce_abc',
    });

    const url = new URL(urlString);
    expect(url.origin).toBe('https://www.tiktok.com');
    expect(url.pathname).toBe('/v2/auth/authorize/');
    expect(url.searchParams.get('client_key')).toBe('chave_tiktok_app_123');
    expect(url.searchParams.get('client_id')).toBeNull(); // TikTok exige client_key
    expect(url.searchParams.get('redirect_uri')).toBe('https://exemplo.com/v1/oauth/tiktok/callback');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('user.info.basic,video.publish');
    expect(url.searchParams.get('state')).toBe('estado_aleatorio_789');
    expect(url.searchParams.get('code_challenge')).toBe('desafio_pkce_abc');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

describe('TikTok publisher — validações de UX e regras de negócio', () => {
  const adapter = createTikTokAdapter();
  const creds = {
    accessToken: 'token_acesso_tiktok',
    scopes: ['user.info.basic', 'video.publish'],
  };
  const ctx = {
    organizationId: 'org_1',
    correlationId: 'corr_1',
    timeoutMs: 5000,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  };

  it('recusa publicação sem mídia', async () => {
    await expect(
      adapter.publisher.publish(creds, { body: '', hashtags: [], media: [] }, ctx),
    ).rejects.toThrow('O TikTok exige pelo menos um arquivo para publicar.');
  });

  it('recusa agendamento nativo com UnsupportedByPlatformError', async () => {
    await expect(
      adapter.publisher.publish(
        creds,
        {
          body: 'Teste',
          hashtags: [],
          media: [{ id: 'm1', type: 'VIDEO', url: 'https://exemplo.com/v.mp4', mimeType: 'video/mp4' }],
          publishAt: new Date(),
        },
        ctx,
      ),
    ).rejects.toThrow(/agendamento nativo/);
  });

  it('recusa exclusão de post com UnsupportedByPlatformError', async () => {
    await expect(
      adapter.publisher.deletePost(creds, 'post_id_123', ctx),
    ).rejects.toThrow(/excluir publicação/);
  });

  it('recusa publicação sem consentimento obrigatório de música', async () => {
    await expect(
      adapter.publisher.publish(
        creds,
        {
          body: 'Vídeo teste',
          hashtags: [],
          media: [{ id: 'm1', type: 'VIDEO', url: 'https://exemplo.com/v.mp4', mimeType: 'video/mp4' }],
          platformFields: {
            privacy_level: 'PUBLIC_TO_EVERYONE',
            music_usage_consent: false,
          },
        },
        ctx,
      ),
    ).rejects.toThrow('Confirmação de Uso de Música');
  });

  it('recusa publicação sem escolha explícita de nível de privacidade', async () => {
    await expect(
      adapter.publisher.publish(
        creds,
        {
          body: 'Vídeo teste',
          hashtags: [],
          media: [{ id: 'm1', type: 'VIDEO', url: 'https://exemplo.com/v.mp4', mimeType: 'video/mp4' }],
          platformFields: {
            music_usage_consent: true,
          },
        },
        ctx,
      ),
    ).rejects.toThrow('nível de privacidade');
  });
});
