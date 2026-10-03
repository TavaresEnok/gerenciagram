import { describe, expect, it } from 'vitest';
import type { PlatformDefinition, PlatformKey } from '../platform/capabilities.js';
import { PLATFORM_REGISTRY } from '../platform/registry.js';
import {
  validateTargets,
  type TargetValidationInput,
  type ValidationContext,
} from './target-validator.js';
import { textSimilarity } from './similarity.js';

/**
 * Cenários obrigatórios da SPEC seção 21 que cabem no validador puro.
 */

const NOW = new Date('2026-09-10T12:00:00.000Z');

/** Definição sintética: uma rede que PROÍBE conteúdo igual, como o X. */
const strictPlatform: PlatformDefinition = {
  key: 'X',
  displayName: 'X',
  isAvailable: true,
  unavailableReason: null,
  capabilities: {
    publishImage: { level: 'SUPPORTED', requiresAppReview: false, requiresBusinessAccount: false },
    publishVideo: { level: 'SUPPORTED', requiresAppReview: false, requiresBusinessAccount: false },
    publishCarousel: { level: 'SUPPORTED', requiresAppReview: false, requiresBusinessAccount: false },
    publishStory: { level: 'UNSUPPORTED', requiresAppReview: false, requiresBusinessAccount: false },
    publishText: { level: 'SUPPORTED', requiresAppReview: false, requiresBusinessAccount: false },
    scheduleNatively: { level: 'UNSUPPORTED', requiresAppReview: false, requiresBusinessAccount: false },
    readAccountMetrics: { level: 'SUPPORTED', requiresAppReview: false, requiresBusinessAccount: false },
    readPostMetrics: { level: 'SUPPORTED', requiresAppReview: false, requiresBusinessAccount: false },
    readComments: { level: 'SUPPORTED', requiresAppReview: false, requiresBusinessAccount: false },
    replyToComments: { level: 'SUPPORTED', requiresAppReview: false, requiresBusinessAccount: false },
    readDirectMessages: { level: 'PARTIAL', requiresAppReview: false, requiresBusinessAccount: false },
    deletePost: { level: 'SUPPORTED', requiresAppReview: false, requiresBusinessAccount: false },
  },
  mediaRequirements: {
    mediaRequired: false,
    titleRequired: false,
    maxCaptionLength: 280,
  },
  quotaRules: {
    verified: true,
    rules: [
      { scope: 'ACCOUNT', unit: 'POSTS', limit: 3, costPerPublish: 1, windowHours: 24, resetsAtUtcHour: 0 },
    ],
  },
  duplicateContentPolicy: {
    policy: 'FORBIDDEN',
    explanation: 'Esta plataforma proíbe conteúdo idêntico ou semelhante em várias contas.',
    policyUrl: 'https://exemplo.invalid/politica',
    similarityThreshold: 0.9,
  },
  requiredUxFields: { fields: [], mustShowTargetProfile: false },
  oauthScopes: [],
  docsUrl: null,
  credentialEnvVars: ['X_CLIENT_ID', 'X_CLIENT_SECRET'],
};

const definitions = { ...PLATFORM_REGISTRY, X: strictPlatform } as Record<
  PlatformKey,
  PlatformDefinition
>;

function makeContext(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    definitions,
    configuredPlatforms: new Set<PlatformKey>(['YOUTUBE', 'X']),
    quota: { accountUsage: new Map(), appUsage: new Map() },
    now: NOW,
    ...overrides,
  };
}

function makeTarget(overrides: Partial<TargetValidationInput> = {}): TargetValidationInput {
  return {
    targetKey: 't1',
    accountId: 'a1',
    accountLabel: 'Conta 1',
    platform: 'YOUTUBE',
    accountStatus: 'ACTIVE',
    accountTimezone: 'America/Sao_Paulo',
    title: 'Título de teste',
    body: 'Descrição do vídeo.',
    hashtags: [],
    platformFields: { privacyStatus: 'public', categoryId: '22', madeForKids: false },
    media: [
      {
        mediaAssetId: 'm1',
        filename: 'video.mp4',
        mimeType: 'video/mp4',
        type: 'VIDEO',
        sizeBytes: 10_000_000,
        durationMs: 60_000,
        width: 1920,
        height: 1080,
        processingStatus: 'READY',
      },
    ],
    scheduledAt: new Date('2026-09-14T13:00:00.000Z'),
    ...overrides,
  };
}

describe('destino válido', () => {
  it('passa sem nenhum erro', () => {
    const result = validateTargets([makeTarget()], makeContext());
    const errors = result.targets[0]?.issues.filter((i) => i.severity === 'ERROR') ?? [];
    expect(errors).toEqual([]);
    expect(result.allValid).toBe(true);
  });
});

describe('revisão humana de conteúdo de IA (SPEC seção 6)', () => {
  it('bloqueia no AGENDAMENTO o conteúdo de IA ainda não revisado', () => {
    // A mesma regra que o worker aplica na última barreira aparece aqui,
    // na tela, antes de confirmar — o usuário não descobre às 3h da manhã.
    const result = validateTargets([makeTarget({ aiNeedsReview: true })], makeContext());

    const erros = result.targets[0]?.issues.filter((i) => i.severity === 'ERROR') ?? [];
    expect(erros.map((issue) => issue.code)).toContain('AI_REVIEW_REQUIRED');
    expect(result.allValid).toBe(false);
  });

  it('depois da revisão, o conteúdo de IA agenda normalmente', () => {
    const result = validateTargets([makeTarget({ aiNeedsReview: false })], makeContext());
    const erros = result.targets[0]?.issues.filter((i) => i.severity === 'ERROR') ?? [];
    expect(erros).toEqual([]);
  });
});

describe('conteúdo igual em várias contas', () => {
  it('BLOQUEIA na plataforma que proíbe (cenário do X na SPEC seção 21)', () => {
    const targets = [
      makeTarget({
        targetKey: 't1',
        accountId: 'x1',
        accountLabel: 'X 1',
        platform: 'X',
        title: null,
        body: 'Promoção imperdível hoje!',
        media: [],
        platformFields: {},
      }),
      makeTarget({
        targetKey: 't2',
        accountId: 'x2',
        accountLabel: 'X 2',
        platform: 'X',
        title: null,
        body: 'Promoção imperdível hoje!',
        media: [],
        platformFields: {},
      }),
    ];

    const result = validateTargets(targets, makeContext());

    expect(result.allValid).toBe(false);
    for (const target of result.targets) {
      const issue = target.issues.find((i) => i.code === 'DUPLICATE_CONTENT_FORBIDDEN');
      expect(issue?.severity).toBe('ERROR');
      expect(issue?.message).toContain('X 1');
      expect(issue?.message).toContain('X 2');
    }
  });

  it('pega texto apenas SEMELHANTE, não só idêntico', () => {
    const targets = [
      makeTarget({
        targetKey: 't1',
        accountId: 'x1',
        accountLabel: 'X 1',
        platform: 'X',
        title: null,
        body: 'Promoção imperdível hoje!',
        media: [],
        platformFields: {},
      }),
      makeTarget({
        targetKey: 't2',
        accountId: 'x2',
        accountLabel: 'X 2',
        platform: 'X',
        title: null,
        body: 'Promoção imperdível hoje!!',
        media: [],
        platformFields: {},
      }),
    ];

    const result = validateTargets(targets, makeContext());
    expect(result.allValid).toBe(false);
  });

  it('não bloqueia textos genuinamente diferentes', () => {
    const targets = [
      makeTarget({
        targetKey: 't1',
        accountId: 'x1',
        accountLabel: 'X 1',
        platform: 'X',
        title: null,
        body: 'Receita de bolo de cenoura com cobertura.',
        media: [],
        platformFields: {},
      }),
      makeTarget({
        targetKey: 't2',
        accountId: 'x2',
        accountLabel: 'X 2',
        platform: 'X',
        title: null,
        body: 'Dez curiosidades sobre o sistema solar.',
        media: [],
        platformFields: {},
      }),
    ];

    const result = validateTargets(targets, makeContext());
    expect(result.allValid).toBe(true);
  });

  it('só AVISA onde a política é apenas de risco (YouTube)', () => {
    const targets = [
      makeTarget({ targetKey: 't1', accountId: 'y1', accountLabel: 'Canal 1' }),
      makeTarget({ targetKey: 't2', accountId: 'y2', accountLabel: 'Canal 2' }),
    ];

    const result = validateTargets(targets, makeContext());
    expect(result.allValid).toBe(true);

    const warning = result.targets[0]?.issues.find((i) => i.code === 'DUPLICATE_CONTENT_RISK');
    expect(warning?.severity).toBe('WARNING');
  });

  it('não compara entre plataformas diferentes', () => {
    const targets = [
      makeTarget({ targetKey: 't1', accountId: 'y1', accountLabel: 'Canal', body: 'Mesmo texto' }),
      makeTarget({
        targetKey: 't2',
        accountId: 'x1',
        accountLabel: 'X 1',
        platform: 'X',
        title: null,
        body: 'Mesmo texto',
        media: [],
        platformFields: {},
      }),
    ];

    const result = validateTargets(targets, makeContext());
    const codes = result.targets.flatMap((t) => t.issues.map((i) => i.code));
    expect(codes).not.toContain('DUPLICATE_CONTENT_FORBIDDEN');
  });
});

describe('cota', () => {
  it('detecta a cota do dia estourada no agendamento (SPEC seção 21)', () => {
    const ctx = makeContext({
      quota: {
        accountUsage: new Map([['X:x1', { count: 3, units: 0 }]]),
        appUsage: new Map(),
      },
    });

    const result = validateTargets(
      [
        makeTarget({
          targetKey: 't1',
          accountId: 'x1',
          accountLabel: 'X 1',
          platform: 'X',
          title: null,
          body: 'Texto',
          media: [],
          platformFields: {},
        }),
      ],
      ctx,
    );

    const issue = result.targets[0]?.issues.find((i) => i.code === 'QUOTA_EXCEEDED');
    expect(issue?.severity).toBe('ERROR');
    expect(result.allValid).toBe(false);
  });

  it('conta o LOTE junto: 20 destinos não passam um a um pela cota de app', () => {
    // O YouTube tem cota de app de 100 uploads/dia. Com 99 já usados, um lote
    // de 3 destinos deve reprovar os dois últimos.
    const ctx = makeContext({
      quota: {
        accountUsage: new Map(),
        appUsage: new Map([['YOUTUBE', { count: 99, units: 0 }]]),
      },
    });

    const targets = [
      makeTarget({ targetKey: 't1', accountId: 'y1', accountLabel: 'Canal 1', body: 'A' }),
      makeTarget({ targetKey: 't2', accountId: 'y2', accountLabel: 'Canal 2', body: 'B' }),
      makeTarget({ targetKey: 't3', accountId: 'y3', accountLabel: 'Canal 3', body: 'C' }),
    ];

    const result = validateTargets(targets, ctx);

    const quotaIssues = result.targets.map((t) =>
      t.issues.some((i) => i.code === 'QUOTA_EXCEEDED'),
    );
    expect(quotaIssues).toEqual([false, true, true]);
  });

  it('a cota de APP explica que o limite é compartilhado por toda a plataforma', () => {
    const ctx = makeContext({
      quota: { accountUsage: new Map(), appUsage: new Map([['YOUTUBE', { count: 100, units: 0 }]]) },
    });

    const result = validateTargets([makeTarget()], ctx);
    const issue = result.targets[0]?.issues.find((i) => i.code === 'QUOTA_EXCEEDED');
    expect(issue?.message).toContain('compartilhado por toda a plataforma');
  });

  it('limite NÃO verificado vira aviso, nunca bloqueio', () => {
    const unverified: PlatformDefinition = {
      ...strictPlatform,
      quotaRules: { ...strictPlatform.quotaRules, verified: false },
    };

    const ctx = makeContext({
      definitions: { ...definitions, X: unverified },
      quota: { accountUsage: new Map([['X:x1', { count: 3, units: 0 }]]), appUsage: new Map() },
    });

    const result = validateTargets(
      [
        makeTarget({
          targetKey: 't1',
          accountId: 'x1',
          accountLabel: 'X 1',
          platform: 'X',
          title: null,
          body: 'Texto',
          media: [],
          platformFields: {},
        }),
      ],
      ctx,
    );

    const issue = result.targets[0]?.issues.find((i) => i.code === 'QUOTA_LIKELY_EXCEEDED');
    expect(issue?.severity).toBe('WARNING');
    expect(result.allValid).toBe(true);
  });
});

describe('campos obrigatórios da plataforma', () => {
  it('não deixa passar campo obrigatório faltando por causa de seleção via grupo', () => {
    const result = validateTargets(
      [makeTarget({ platformFields: { privacyStatus: 'public' } })],
      makeContext(),
    );

    const missing = result.targets[0]?.issues.filter((i) => i.code === 'REQUIRED_FIELD_MISSING');
    expect(missing?.map((i) => i.field).sort()).toEqual(['categoryId', 'madeForKids']);
    expect(result.allValid).toBe(false);
  });

  it('rejeita valor fora da lista fixa de opções', () => {
    const result = validateTargets(
      [makeTarget({ platformFields: { privacyStatus: 'secreto', categoryId: '22', madeForKids: false } })],
      makeContext(),
    );

    const issue = result.targets[0]?.issues.find((i) => i.code === 'REQUIRED_FIELD_INVALID');
    expect(issue?.field).toBe('privacyStatus');
  });

  it('não inventa validação para opções que vêm da API', () => {
    // categoryId é optionsFromApi: qualquer valor não-vazio passa aqui.
    const result = validateTargets(
      [makeTarget({ platformFields: { privacyStatus: 'public', categoryId: '999', madeForKids: true } })],
      makeContext(),
    );

    const invalid = result.targets[0]?.issues.filter(
      (i) => i.code === 'REQUIRED_FIELD_INVALID' && i.field === 'categoryId',
    );
    expect(invalid).toEqual([]);
  });
});

describe('estado da conta e horário', () => {
  it('bloqueia destino com token expirado', () => {
    const result = validateTargets(
      [makeTarget({ accountStatus: 'NEEDS_RECONNECT' })],
      makeContext(),
    );
    const issue = result.targets[0]?.issues.find((i) => i.code === 'ACCOUNT_NEEDS_RECONNECT');
    expect(issue?.severity).toBe('ERROR');
    expect(issue?.message).toContain('reconectada');
  });

  it('bloqueia agendamento no passado', () => {
    const result = validateTargets(
      [makeTarget({ scheduledAt: new Date('2026-09-01T00:00:00.000Z') })],
      makeContext(),
    );
    expect(result.targets[0]?.issues.some((i) => i.code === 'SCHEDULE_IN_PAST')).toBe(true);
  });

  it('falha de um destino não contamina os outros', () => {
    // O caso central da SPEC: 3 falham, 17 seguem.
    const targets = Array.from({ length: 20 }, (_, i) =>
      makeTarget({
        targetKey: `t${i}`,
        accountId: `y${i}`,
        accountLabel: `Canal ${i}`,
        body: `Conteúdo único número ${i}`,
        accountStatus: i < 3 ? 'NEEDS_RECONNECT' : 'ACTIVE',
      }),
    );

    const result = validateTargets(targets, makeContext());

    expect(result.schedulableTargetKeys).toHaveLength(17);
    expect(result.allValid).toBe(false);
  });
});

describe('plataforma indisponível ou não configurada', () => {
  it('usa a mensagem exigida pela SPEC para rede sem API oficial', () => {
    const result = validateTargets(
      [makeTarget({ platform: 'KWAI', accountId: 'k1', accountLabel: 'Kwai 1' })],
      makeContext({ configuredPlatforms: new Set<PlatformKey>(['YOUTUBE', 'X', 'KWAI']) }),
    );

    const issue = result.targets[0]?.issues.find((i) => i.code === 'PLATFORM_UNAVAILABLE');
    expect(issue?.severity).toBe('ERROR');
  });

  it('avisa quando faltam as credenciais do app neste ambiente', () => {
    const result = validateTargets(
      [makeTarget()],
      makeContext({ configuredPlatforms: new Set<PlatformKey>([]) }),
    );

    const issue = result.targets[0]?.issues.find((i) => i.code === 'PLATFORM_NOT_CONFIGURED');
    expect(issue?.severity).toBe('ERROR');
    expect(issue?.message).toContain('credenciais do aplicativo');
  });
});

describe('mídia', () => {
  it('rejeita formato que a plataforma não aceita', () => {
    const result = validateTargets(
      [
        makeTarget({
          media: [
            {
              mediaAssetId: 'm1',
              filename: 'arquivo.mkv',
              mimeType: 'video/x-matroska',
              type: 'VIDEO',
              sizeBytes: 1000,
              durationMs: 5000,
              width: 1920,
              height: 1080,
              processingStatus: 'READY',
            },
          ],
        }),
      ],
      makeContext(),
    );

    expect(result.targets[0]?.issues.some((i) => i.code === 'MEDIA_MIME_UNSUPPORTED')).toBe(true);
  });

  it('rejeita vídeo mais longo que o limite da plataforma', () => {
    const result = validateTargets(
      [
        makeTarget({
          media: [
            {
              mediaAssetId: 'm1',
              filename: 'longo.mp4',
              mimeType: 'video/mp4',
              type: 'VIDEO',
              sizeBytes: 1000,
              durationMs: 50_000_000, // ~13h, acima do limite de 12h
              width: 1920,
              height: 1080,
              processingStatus: 'READY',
            },
          ],
        }),
      ],
      makeContext(),
    );

    expect(result.targets[0]?.issues.some((i) => i.code === 'MEDIA_TOO_LONG')).toBe(true);
  });

  it('avisa (sem bloquear) quando a mídia ainda está em processamento', () => {
    const result = validateTargets(
      [
        makeTarget({
          media: [
            {
              mediaAssetId: 'm1',
              filename: 'video.mp4',
              mimeType: 'video/mp4',
              type: 'VIDEO',
              sizeBytes: 1000,
              durationMs: null,
              width: null,
              height: null,
              processingStatus: 'PROCESSING',
            },
          ],
        }),
      ],
      makeContext(),
    );

    const issue = result.targets[0]?.issues.find((i) => i.code === 'MEDIA_NOT_READY');
    expect(issue?.severity).toBe('WARNING');
  });

  it('bloqueia título acima do limite do YouTube', () => {
    const result = validateTargets(
      [makeTarget({ title: 'x'.repeat(101) })],
      makeContext(),
    );
    expect(result.targets[0]?.issues.some((i) => i.code === 'TITLE_TOO_LONG')).toBe(true);
  });

  it('exige título onde a plataforma exige', () => {
    const result = validateTargets([makeTarget({ title: '   ' })], makeContext());
    expect(result.targets[0]?.issues.some((i) => i.code === 'TITLE_REQUIRED')).toBe(true);
  });
});

describe('similaridade de texto', () => {
  it('trata acentuação e caixa como iguais', () => {
    expect(textSimilarity('Promoção HOJE', 'promocao hoje')).toBe(1);
  });

  it('distingue textos diferentes', () => {
    expect(textSimilarity('bolo de cenoura', 'sistema solar')).toBeLessThan(0.3);
  });
});

describe('política REAL do X (registro de plataformas)', () => {
  /**
   * Cenário obrigatório da SPEC seção 21, agora contra a definição de
   * verdade — não contra uma plataforma sintética de teste.
   *
   * A regra de automação do X proíbe publicar conteúdo duplicado ou
   * substancialmente semelhante em várias contas operadas pela mesma pessoa,
   * então a política no registro é FORBIDDEN e o agendamento é barrado.
   */
  it('bloqueia o mesmo conteúdo em duas contas do X', () => {
    const targets = [
      makeTarget({
        targetKey: 't1',
        accountId: 'x1',
        accountLabel: 'X 1',
        platform: 'X',
        title: null,
        body: 'Promoção imperdível hoje!',
        media: [],
        platformFields: {},
      }),
      makeTarget({
        targetKey: 't2',
        accountId: 'x2',
        accountLabel: 'X 2',
        platform: 'X',
        title: null,
        body: 'Promoção imperdível hoje!',
        media: [],
        platformFields: {},
      }),
    ];

    const result = validateTargets(targets, {
      definitions: PLATFORM_REGISTRY,
      configuredPlatforms: new Set<PlatformKey>(['X']),
      quota: { accountUsage: new Map(), appUsage: new Map() },
      now: NOW,
    });

    for (const target of result.targets) {
      const issue = target.issues.find((i) => i.code === 'DUPLICATE_CONTENT_FORBIDDEN');
      expect(issue?.severity).toBe('ERROR');
      expect(issue?.message).toContain('proíbe');
    }
  });

  it('o Kwai continua indisponível com a mensagem exigida pela SPEC', () => {
    const definicao = PLATFORM_REGISTRY.KWAI;

    expect(definicao.isAvailable).toBe(false);
    expect(definicao.unavailableReason).toContain(
      'não está disponível pela API oficial desta plataforma',
    );
    expect(definicao.capabilities.publishVideo.level).toBe('UNSUPPORTED');
  });

  it('o TikTok exige privacidade escolhida pelo usuário e consentimento', () => {
    const campos = PLATFORM_REGISTRY.TIKTOK.requiredUxFields;

    expect(campos.mustShowTargetProfile).toBe(true);

    const privacidade = campos.fields.find((campo) => campo.key === 'privacy_level');
    expect(privacidade?.required).toBe(true);
    // As opções vêm da API por conta — fixá-las seria inventar comportamento.
    expect(privacidade?.optionsFromApi).toBe(true);
    expect(privacidade?.options).toHaveLength(0);

    const consentimento = campos.fields.find((campo) => campo.type === 'CONSENT');
    expect(consentimento?.required).toBe(true);
    expect(consentimento?.consentText).toBeTruthy();
  });
});
