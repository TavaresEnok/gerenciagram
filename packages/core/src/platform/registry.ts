import type { Capability, PlatformDefinition, PlatformKey } from './capabilities.js';

/**
 * Registro das plataformas.
 *
 * ------------------------------------------------------------------------
 *  REGRA (SPEC regra 6 e seção 19): nada aqui pode ser inventado.
 *
 *  Cada definição só sai de `UNKNOWN` depois que a documentação oficial
 *  atual daquela plataforma for consultada, na fase correspondente do
 *  roadmap. Enquanto isso, a rede fica com `isAvailable: false` e a UI
 *  mostra o motivo — em vez de fingir suporte.
 *
 *  `quotaRules.verified = false` faz o validador AVISAR em vez de BLOQUEAR,
 *  justamente para não bloquear um agendamento com base num número que não
 *  foi confirmado.
 * ------------------------------------------------------------------------
 */

const UNKNOWN: Capability = { level: 'UNKNOWN', requiresAppReview: false, requiresBusinessAccount: false };

const unknownCapabilities = {
  publishImage: UNKNOWN,
  publishVideo: UNKNOWN,
  publishCarousel: UNKNOWN,
  publishStory: UNKNOWN,
  publishText: UNKNOWN,
  scheduleNatively: UNKNOWN,
  readAccountMetrics: UNKNOWN,
  readPostMetrics: UNKNOWN,
  readComments: UNKNOWN,
  replyToComments: UNKNOWN,
  readDirectMessages: UNKNOWN,
  deletePost: UNKNOWN,
};

/** Placeholder honesto para rede ainda não implementada. */
function pending(
  key: PlatformKey,
  displayName: string,
  phase: string,
  credentialEnvVars: string[],
  docsUrl: string,
): PlatformDefinition {
  return {
    key,
    displayName,
    isAvailable: false,
    unavailableReason:
      `A integração com ${displayName} ainda não foi implementada (${phase}). ` +
      `As capacidades desta rede só serão declaradas depois da consulta à ` +
      `documentação oficial atual, conforme a regra 6 da especificação.`,
    capabilities: unknownCapabilities,
    mediaRequirements: { mediaRequired: true, titleRequired: false },
    quotaRules: { rules: [], verified: false },
    duplicateContentPolicy: {
      policy: 'RESTRICTED',
      explanation:
        `A política de ${displayName} sobre publicar o mesmo conteúdo em várias ` +
        `contas ainda não foi verificada. Até lá, o sistema avisa em vez de bloquear.`,
      similarityThreshold: 0.9,
    },
    requiredUxFields: { fields: [], mustShowTargetProfile: false },
    oauthScopes: [],
    docsUrl,
    credentialEnvVars,
  };
}

// ===========================================================================
//  YOUTUBE — plataforma da Fase 0
//
//  Verificado em 2026-09-10 na documentação oficial:
//    https://developers.google.com/youtube/v3/getting-started
//    https://developers.google.com/youtube/v3/determine_quota_cost
//
//  Cota (modelo de buckets granulares, NÃO o antigo "1600 unidades"):
//    - 100 chamadas videos.insert/dia   -> bucket próprio
//    - 100 chamadas search.list/dia     -> bucket próprio
//    - 10.000 unidades/dia              -> demais endpoints, somados
//
//  Os três limites são POR PROJETO do Google Cloud, ou seja, compartilhados
//  por TODOS os clientes do SaaS (SPEC seção 12). É por isso que estas
//  regras têm scope 'APP' e não 'ACCOUNT'.
// ===========================================================================

const youtube: PlatformDefinition = {
  key: 'YOUTUBE',
  displayName: 'YouTube',
  isAvailable: true,
  unavailableReason: null,
  capabilities: {
    publishVideo: {
      level: 'SUPPORTED',
      requiresAppReview: false,
      requiresBusinessAccount: false,
      limitation:
        'Projetos sem auditoria de conformidade publicam vídeos travados em "privado", ' +
        'independentemente do privacyStatus enviado.',
    },
    publishImage: {
      level: 'UNSUPPORTED',
      requiresAppReview: false,
      requiresBusinessAccount: false,
      limitation: 'A API de dados do YouTube publica vídeos, não imagens avulsas.',
    },
    publishCarousel: { level: 'UNSUPPORTED', requiresAppReview: false, requiresBusinessAccount: false },
    publishStory: { level: 'UNSUPPORTED', requiresAppReview: false, requiresBusinessAccount: false },
    publishText: { level: 'UNSUPPORTED', requiresAppReview: false, requiresBusinessAccount: false },
    scheduleNatively: {
      level: 'SUPPORTED',
      requiresAppReview: false,
      requiresBusinessAccount: false,
      limitation:
        'status.publishAt agenda no próprio YouTube, mas exige privacyStatus=private no envio.',
    },
    readAccountMetrics: {
      level: 'PARTIAL',
      requiresAppReview: false,
      requiresBusinessAccount: false,
      limitation:
        'Métricas detalhadas exigem a YouTube Analytics API, que é um escopo separado.',
    },
    readPostMetrics: { level: 'SUPPORTED', requiresAppReview: false, requiresBusinessAccount: false },
    readComments: { level: 'SUPPORTED', requiresAppReview: false, requiresBusinessAccount: false },
    replyToComments: { level: 'SUPPORTED', requiresAppReview: false, requiresBusinessAccount: false },
    readDirectMessages: {
      level: 'UNSUPPORTED',
      requiresAppReview: false,
      requiresBusinessAccount: false,
      limitation: 'O YouTube não expõe mensagens diretas por API.',
    },
    deletePost: { level: 'SUPPORTED', requiresAppReview: false, requiresBusinessAccount: false },
  },
  mediaRequirements: {
    video: {
      mimeTypes: [
        'video/mp4',
        'video/quicktime',
        'video/x-msvideo',
        'video/mpeg',
        'video/webm',
        'video/x-ms-wmv',
        'video/3gpp',
      ],
      // 128 GB — limite de tamanho de arquivo documentado para upload.
      maxSizeBytes: 137_438_953_472,
      // 12 horas para contas verificadas.
      maxDurationMs: 43_200_000,
      aspectRatios: [],
      aspectRatioTolerance: 0.02,
      maxItemsPerPost: 1,
    },
    mediaRequired: true,
    // snippet.title: 100 caracteres.
    maxTitleLength: 100,
    titleRequired: true,
    // snippet.description: 5000 caracteres.
    maxCaptionLength: 5000,
    // snippet.tags: 500 caracteres somados — o limite de contagem é indireto.
    maxHashtags: 15,
  },
  quotaRules: {
    verified: true,
    sourceUrl: 'https://developers.google.com/youtube/v3/getting-started',
    rules: [
      {
        scope: 'APP',
        unit: 'POSTS',
        limit: 100,
        costPerPublish: 1,
        windowHours: 24,
        resetsAtUtcHour: 7, // meia-noite no Pacífico (PDT = UTC-7)
        note:
          'Bucket "Video Uploads": 100 chamadas videos.insert por dia, POR PROJETO do ' +
          'Google Cloud. É compartilhado por todos os clientes do SaaS — um cliente pode ' +
          'esgotar a cota dos demais. Aumento via Quota extension request form.',
      },
      {
        scope: 'APP',
        unit: 'UNITS',
        limit: 10_000,
        costPerPublish: 2, // videos.list + channels.list de verificação pós-upload
        windowHours: 24,
        resetsAtUtcHour: 7,
        note:
          'Bucket geral: 10.000 unidades/dia por projeto, somando todos os endpoints ' +
          'exceto videos.insert e search.list, que têm buckets próprios.',
      },
    ],
  },
  duplicateContentPolicy: {
    policy: 'RESTRICTED',
    explanation:
      'O YouTube não proíbe publicar o mesmo vídeo em canais diferentes, mas as políticas ' +
      'de spam e conteúdo repetitivo podem penalizar canais que republicam material idêntico ' +
      'sem valor agregado. O sistema avisa, mas não bloqueia.',
    policyUrl: 'https://support.google.com/youtube/answer/2801973',
    similarityThreshold: 0.95,
  },
  requiredUxFields: {
    mustShowTargetProfile: true,
    guidelinesUrl: 'https://developers.google.com/youtube/terms/developer-policies',
    fields: [
      {
        key: 'privacyStatus',
        label: 'Visibilidade',
        type: 'SELECT',
        required: true,
        optionsFromApi: false,
        options: [
          { value: 'public', label: 'Público' },
          { value: 'unlisted', label: 'Não listado' },
          { value: 'private', label: 'Privado' },
        ],
        helpText:
          'Projetos sem auditoria de conformidade do YouTube publicam sempre como privado, ' +
          'mesmo que outra opção seja escolhida aqui.',
      },
      {
        key: 'categoryId',
        label: 'Categoria',
        type: 'SELECT',
        required: true,
        // As categorias variam por região e são retornadas por videoCategories.list.
        // Fixá-las aqui seria inventar comportamento de API.
        optionsFromApi: true,
        options: [],
        helpText: 'Carregada de videoCategories.list para a região do canal.',
      },
      {
        key: 'madeForKids',
        label: 'Conteúdo feito para crianças',
        type: 'BOOLEAN',
        required: true,
        optionsFromApi: false,
        options: [],
        helpText:
          'Declaração obrigatória exigida pela COPPA. O YouTube rejeita o upload sem ela.',
      },
    ],
  },
  oauthScopes: [
    // Menor privilégio (SPEC seção 10): só o necessário para publicar e ler o
    // próprio canal. `youtube.force-ssl` só entra quando o Inbox for ativado.
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube.readonly',
  ],
  docsUrl: 'https://developers.google.com/youtube/v3/docs/videos/insert',
  credentialEnvVars: ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET'],
};

// ===========================================================================

export const PLATFORM_REGISTRY: Record<PlatformKey, PlatformDefinition> = {
  YOUTUBE: youtube,
  INSTAGRAM: pending(
    'INSTAGRAM',
    'Instagram',
    'Fase 6',
    ['META_APP_ID', 'META_APP_SECRET'],
    'https://developers.facebook.com/docs/instagram-platform',
  ),
  FACEBOOK: pending(
    'FACEBOOK',
    'Facebook',
    'Fase 6',
    ['META_APP_ID', 'META_APP_SECRET'],
    'https://developers.facebook.com/docs/pages-api',
  ),
  TIKTOK: pending(
    'TIKTOK',
    'TikTok',
    'Fase 7',
    ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'],
    'https://developers.tiktok.com/doc/content-posting-api-get-started',
  ),
  X: pending(
    'X',
    'X',
    'Fase 9',
    ['X_CLIENT_ID', 'X_CLIENT_SECRET'],
    'https://docs.x.com/x-api',
  ),
  KWAI: pending(
    'KWAI',
    'Kwai',
    'Fase 10',
    ['KWAI_CLIENT_ID', 'KWAI_CLIENT_SECRET'],
    'https://developers.kwai.com',
  ),
};

export function getPlatformDefinition(key: PlatformKey): PlatformDefinition {
  const def = PLATFORM_REGISTRY[key];
  if (!def) throw new Error(`Plataforma desconhecida: ${key}`);
  return def;
}

export function listPlatformDefinitions(): PlatformDefinition[] {
  return Object.values(PLATFORM_REGISTRY);
}

/**
 * Uma plataforma só está utilizável quando (a) foi declarada disponível e
 * (b) as credenciais do app existem NESTE ambiente. As duas coisas são
 * diferentes: o YouTube está implementado, mas continua inutilizável até
 * alguém preencher YOUTUBE_CLIENT_ID/SECRET.
 */
export function hasCredentials(def: PlatformDefinition, env: NodeJS.ProcessEnv): boolean {
  if (def.credentialEnvVars.length === 0) return false;
  return def.credentialEnvVars.every((name) => {
    const value = env[name];
    return typeof value === 'string' && value.trim().length > 0;
  });
}
