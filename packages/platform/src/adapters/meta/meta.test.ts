import { createHmac } from 'node:crypto';
import { PLATFORM_REGISTRY } from '@app/core';
import { describe, expect, it } from 'vitest';
import { createFacebookAdapter, createInstagramAdapter } from './index.js';
import { createMetaWebhookVerifier } from './webhooks.js';

/**
 * O que dá para provar sem credencial da Meta.
 *
 * Publicar de verdade exige app aprovado; a verificação de assinatura, a
 * montagem da URL de autorização e o contrato do adapter, não — e são
 * justamente as partes onde um erro é silencioso e caro.
 */

const APP_SECRET = 'segredo-de-teste-do-app';
const VERIFY_TOKEN = 'token-de-verificacao';

function assinar(corpo: Buffer, segredo = APP_SECRET): string {
  return `sha256=${createHmac('sha256', segredo).update(corpo).digest('hex')}`;
}

describe('verificação de assinatura de webhook', () => {
  const verificador = createMetaWebhookVerifier(APP_SECRET, VERIFY_TOKEN);

  it('aceita uma assinatura válida', () => {
    const corpo = Buffer.from(JSON.stringify({ object: 'instagram', entry: [] }));

    expect(
      verificador.verifySignature(corpo, { 'x-hub-signature-256': assinar(corpo) }),
    ).toBe(true);
  });

  it('recusa assinatura feita com outro segredo', () => {
    const corpo = Buffer.from('{"object":"page"}');

    expect(
      verificador.verifySignature(corpo, {
        'x-hub-signature-256': assinar(corpo, 'segredo-errado'),
      }),
    ).toBe(false);
  });

  it('recusa quando o corpo foi adulterado', () => {
    const original = Buffer.from('{"valor":100}');
    const adulterado = Buffer.from('{"valor":999}');

    expect(
      verificador.verifySignature(adulterado, { 'x-hub-signature-256': assinar(original) }),
    ).toBe(false);
  });

  it('recusa assinatura ausente ou malformada', () => {
    const corpo = Buffer.from('{}');

    expect(verificador.verifySignature(corpo, {})).toBe(false);
    expect(verificador.verifySignature(corpo, { 'x-hub-signature-256': 'lixo' })).toBe(false);
    // Sem o prefixo sha256= — a Meta sempre o envia.
    expect(
      verificador.verifySignature(corpo, {
        'x-hub-signature-256': assinar(corpo).replace('sha256=', ''),
      }),
    ).toBe(false);
  });

  it('assinatura de tamanho diferente não lança, só recusa', () => {
    // timingSafeEqual lança quando os buffers têm tamanhos diferentes. Se a
    // checagem de tamanho sumisse, um webhook malformado viraria exceção 500
    // em vez de um 401 limpo.
    const corpo = Buffer.from('{}');

    expect(() =>
      verificador.verifySignature(corpo, { 'x-hub-signature-256': 'sha256=abcd' }),
    ).not.toThrow();

    expect(verificador.verifySignature(corpo, { 'x-hub-signature-256': 'sha256=abcd' })).toBe(
      false,
    );
  });

  it('o corpo CRU é o que vale, não o JSON reserializado', () => {
    // A Meta assina os bytes que enviou. Reserializar normaliza o
    // espaçamento, e a assinatura deixa de bater — por isso o endpoint guarda
    // o corpo cru em vez de reconstruí-lo a partir do JSON já interpretado.
    const cru = Buffer.from('{ "object": "page", "entry": [ ] }');
    const reserializado = Buffer.from(JSON.stringify(JSON.parse(cru.toString())));

    expect(cru.equals(reserializado)).toBe(false);
    expect(verificador.verifySignature(cru, { 'x-hub-signature-256': assinar(cru) })).toBe(true);
    expect(
      verificador.verifySignature(reserializado, { 'x-hub-signature-256': assinar(cru) }),
    ).toBe(false);
  });
});

describe('desafio de subscrição', () => {
  const verificador = createMetaWebhookVerifier(APP_SECRET, VERIFY_TOKEN);

  it('devolve o desafio quando o token confere', () => {
    expect(
      verificador.handleSubscriptionChallenge?.({
        'hub.mode': 'subscribe',
        'hub.verify_token': VERIFY_TOKEN,
        'hub.challenge': '1234567890',
      }),
    ).toBe('1234567890');
  });

  it('recusa token errado', () => {
    expect(
      verificador.handleSubscriptionChallenge?.({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'errado',
        'hub.challenge': '1234567890',
      }),
    ).toBeNull();
  });

  it('recusa modo diferente de subscribe', () => {
    expect(
      verificador.handleSubscriptionChallenge?.({
        'hub.mode': 'unsubscribe',
        'hub.verify_token': VERIFY_TOKEN,
        'hub.challenge': '1234567890',
      }),
    ).toBeNull();
  });
});

describe('montagem do adapter', () => {
  const opcoes = { apiVersion: 'v21.0', appSecret: APP_SECRET, webhookVerifyToken: VERIFY_TOKEN };

  it('Instagram e Facebook são plataformas distintas', () => {
    expect(createInstagramAdapter(opcoes).platform).toBe('INSTAGRAM');
    expect(createFacebookAdapter(opcoes).platform).toBe('FACEBOOK');
  });

  it('sem segredo do app, NÃO monta o verificador de webhook', () => {
    // A ausência é o que faz o endpoint responder 501. Um verificador que
    // aceitasse tudo seria uma porta aberta.
    const semSegredo = createInstagramAdapter({ apiVersion: 'v21.0' });
    expect(semSegredo.webhooks).toBeUndefined();

    expect(createInstagramAdapter(opcoes).webhooks).toBeDefined();
  });

  it('a URL de autorização carrega escopos, state e redirect', () => {
    const adapter = createInstagramAdapter(opcoes);

    const url = new URL(
      adapter.auth.buildAuthorizationUrl(
        {
          clientId: 'app-123',
          clientSecret: 'segredo',
          redirectUri: 'https://exemplo.invalid/v1/oauth/instagram/callback',
        },
        { state: 'estado-anti-csrf', scopes: ['instagram_business_basic'] },
      ),
    );

    expect(url.searchParams.get('client_id')).toBe('app-123');
    expect(url.searchParams.get('state')).toBe('estado-anti-csrf');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://exemplo.invalid/v1/oauth/instagram/callback',
    );
    // A Meta separa escopos por vírgula, não por espaço como o Google.
    expect(url.searchParams.get('scope')).toBe('instagram_business_basic');
  });

  it('declara as capacidades que o registro afirma', () => {
    const instagram = createInstagramAdapter(opcoes);
    const facebook = createFacebookAdapter(opcoes);

    // Analytics e inbox existem nas duas; webhooks só com segredo.
    expect(instagram.analytics).toBeDefined();
    expect(instagram.inbox).toBeDefined();
    expect(facebook.analytics).toBeDefined();
    expect(facebook.inbox).toBeDefined();

    expect(instagram.definition).toBe(PLATFORM_REGISTRY.INSTAGRAM);
    expect(facebook.definition).toBe(PLATFORM_REGISTRY.FACEBOOK);
  });
});

describe('coerência entre o registro e o adapter', () => {
  it('o Instagram exige mídia e o Facebook não', () => {
    // A diferença não é estilística: publicar só texto é válido numa Página
    // do Facebook e inválido no Instagram, e o validador usa isso.
    expect(PLATFORM_REGISTRY.INSTAGRAM.mediaRequirements.mediaRequired).toBe(true);
    expect(PLATFORM_REGISTRY.FACEBOOK.mediaRequirements.mediaRequired).toBe(false);
  });

  it('só o Facebook declara agendamento nativo entre as duas', () => {
    expect(PLATFORM_REGISTRY.FACEBOOK.capabilities.scheduleNatively.level).toBe('SUPPORTED');
    expect(PLATFORM_REGISTRY.INSTAGRAM.capabilities.scheduleNatively.level).toBe('UNSUPPORTED');
  });

  it('o Instagram exige conta profissional para publicar', () => {
    expect(PLATFORM_REGISTRY.INSTAGRAM.capabilities.publishImage.requiresBusinessAccount).toBe(
      true,
    );
    expect(PLATFORM_REGISTRY.INSTAGRAM.capabilities.publishImage.requiresAppReview).toBe(true);
  });

  it('a cota do Instagram é por CONTA, diferente da do YouTube', () => {
    // A distinção decide se um cliente consome a cota dos outros.
    const instagram = PLATFORM_REGISTRY.INSTAGRAM.quotaRules.rules[0];
    const youtube = PLATFORM_REGISTRY.YOUTUBE.quotaRules.rules[0];

    expect(instagram?.scope).toBe('ACCOUNT');
    expect(instagram?.limit).toBe(100);
    expect(youtube?.scope).toBe('APP');
  });
});
