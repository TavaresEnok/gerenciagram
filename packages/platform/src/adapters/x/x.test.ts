import { Readable } from 'node:stream';
import { PLATFORM_REGISTRY, type PublishMediaInput } from '@app/core';
import { describe, expect, it } from 'vitest';
import { createXAdapter } from './index.js';
import { montarTextoTweet } from './publisher.js';

describe('X (Twitter) adapter — contrato e registro', () => {
  const adapter = createXAdapter();

  it('bate com o registro da plataforma', () => {
    expect(adapter.platform).toBe('X');
    expect(adapter.definition.key).toBe('X');
    expect(PLATFORM_REGISTRY.X.isAvailable).toBe(true);
    expect(PLATFORM_REGISTRY.X.unavailableReason).toBeNull();
  });

  it('declara publicador e autenticador', () => {
    expect(adapter.auth).toBeDefined();
    expect(adapter.publisher).toBeDefined();
  });
});

describe('X OAuth 2.0 PKCE', () => {
  const adapter = createXAdapter();
  const app = {
    clientId: 'meu_x_client_id_123',
    clientSecret: 'meu_x_client_secret_456',
    redirectUri: 'https://exemplo.com/v1/oauth/x/callback',
  };

  it('monta a URL com PKCE, client_id e escopos separados por espaço', () => {
    const urlString = adapter.auth.buildAuthorizationUrl(app, {
      scopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'],
      state: 'estado_seguro_x',
      codeChallenge: 'desafio_pkce_x_sha256',
    });

    const url = new URL(urlString);
    expect(url.origin).toBe('https://twitter.com');
    expect(url.pathname).toBe('/i/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe('meu_x_client_id_123');
    expect(url.searchParams.get('redirect_uri')).toBe('https://exemplo.com/v1/oauth/x/callback');
    expect(url.searchParams.get('response_type')).toBe('code');
    // RFC 6749 do X exige separação por espaço
    expect(url.searchParams.get('scope')).toBe('tweet.read tweet.write users.read offline.access');
    expect(url.searchParams.get('state')).toBe('estado_seguro_x');
    expect(url.searchParams.get('code_challenge')).toBe('desafio_pkce_x_sha256');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

describe('X publisher — validações de regras e montagem de texto', () => {
  const adapter = createXAdapter();
  const creds = {
    accessToken: 'token_acesso_x',
    scopes: ['tweet.read', 'tweet.write'],
  };
  const ctx = {
    organizationId: 'org_1',
    correlationId: 'corr_x_1',
    timeoutMs: 5000,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  };

  function mockMedia(mimeType: string, filename = 'arquivo'): PublishMediaInput {
    return {
      filename,
      mimeType,
      sizeBytes: 1024,
      stream: () => Readable.from([Buffer.from('dados')]),
    };
  }

  it('recusa agendamento nativo com UnsupportedByPlatformError', async () => {
    await expect(
      adapter.publisher.publish(
        creds,
        {
          idempotencyKey: 'idemp_1',
          body: 'Tweet agendado',
          hashtags: [],
          media: [],
          platformFields: {},
          publishAt: new Date(),
        },
        ctx,
      ),
    ).rejects.toThrow(/agendamento nativo/);
  });

  it('recusa tweet vazio sem mídia e sem texto', async () => {
    await expect(
      adapter.publisher.publish(
        creds,
        {
          idempotencyKey: 'idemp_2',
          body: '',
          hashtags: [],
          media: [],
          platformFields: {},
        },
        ctx,
      ),
    ).rejects.toThrow('O X exige texto ou pelo menos uma mídia para publicar.');
  });

  it('recusa publicação com mais de 4 imagens', async () => {
    const cincoImagens = Array.from({ length: 5 }).map((_, i) =>
      mockMedia('image/jpeg', `img_${i}.jpg`),
    );

    await expect(
      adapter.publisher.publish(
        creds,
        {
          idempotencyKey: 'idemp_3',
          body: 'Fotos',
          hashtags: [],
          media: cincoImagens,
          platformFields: {},
        },
        ctx,
      ),
    ).rejects.toThrow('máximo 4 imagens');
  });

  it('recusa publicação com mais de 1 vídeo', async () => {
    const doisVideos = [
      mockMedia('video/mp4', 'v1.mp4'),
      mockMedia('video/mp4', 'v2.mp4'),
    ];

    await expect(
      adapter.publisher.publish(
        creds,
        {
          idempotencyKey: 'idemp_4',
          body: 'Vídeos',
          hashtags: [],
          media: doisVideos,
          platformFields: {},
        },
        ctx,
      ),
    ).rejects.toThrow('apenas 1 vídeo');
  });

  it('monta o texto do tweet juntando corpo e hashtags', () => {
    const texto = montarTextoTweet({
      idempotencyKey: 'idemp_5',
      body: 'Lançamento do novo produto!',
      hashtags: ['novidade', '#tech'],
      media: [],
      platformFields: {},
    });

    expect(texto).toBe('Lançamento do novo produto!\n\n#novidade #tech');
  });

  it('trunca o texto do tweet para 280 caracteres', () => {
    const textoLongo = 'A'.repeat(300);
    const resultado = montarTextoTweet({
      idempotencyKey: 'idemp_6',
      body: textoLongo,
      hashtags: [],
      media: [],
      platformFields: {},
    });

    expect(resultado.length).toBe(280);
  });
});
