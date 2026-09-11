import type { Capability, PlatformDefinition, PlatformKey } from './capabilities.js';

/**
 * Registro das plataformas.
 *
 * ------------------------------------------------------------------------
 *  REGRA (SPEC regra 6 e seção 19): nada aqui pode ser inventado.
 *
 *  Cada campo veio da documentação oficial da plataforma, consultada em
 *  2026-09-10 (as URLs estão em `docsUrl` e nos comentários de cada bloco).
 *  Onde a documentação não afirma um número, `quotaRules.verified` fica
 *  `false` — e o validador AVISA em vez de BLOQUEAR, para não barrar um
 *  agendamento com base num limite que não foi confirmado.
 *
 *  `isAvailable` responde "esta rede está IMPLEMENTADA aqui?", não "esta
 *  rede tem API?". Uma rede com API oficial mas sem adapter escrito continua
 *  indisponível — e a UI diz isso.
 * ------------------------------------------------------------------------
 */

const NAO_SUPORTADO: Capability = {
  level: 'UNSUPPORTED',
  requiresAppReview: false,
  requiresBusinessAccount: false,
};

function cap(
  level: Capability['level'],
  extras: Partial<Omit<Capability, 'level'>> = {},
): Capability {
  return {
    level,
    requiresAppReview: extras.requiresAppReview ?? false,
    requiresBusinessAccount: extras.requiresBusinessAccount ?? false,
    ...(extras.limitation ? { limitation: extras.limitation } : {}),
  };
}

// ===========================================================================
//  YOUTUBE — Fase 0 (implementado)
//
//  Fontes (2026-09-10):
//    https://developers.google.com/youtube/v3/getting-started
//    https://developers.google.com/youtube/v3/determine_quota_cost
//    https://developers.google.com/youtube/v3/docs/videos/insert
//
//  Cota em buckets granulares (NÃO o antigo "1600 unidades por upload"):
//    100 chamadas videos.insert/dia · 100 search.list/dia ·
//    10.000 unidades/dia para os demais endpoints.
//  Os três limites são POR PROJETO do Google Cloud — compartilhados por
//  TODOS os clientes do SaaS (SPEC seção 12).
// ===========================================================================

const youtube: PlatformDefinition = {
  key: 'YOUTUBE',
  displayName: 'YouTube',
  isAvailable: true,
  unavailableReason: null,
  capabilities: {
    publishVideo: cap('SUPPORTED', {
      limitation:
        'Projetos sem auditoria de conformidade publicam vídeos travados em "privado", ' +
        'independentemente do privacyStatus enviado.',
    }),
    publishImage: cap('UNSUPPORTED', {
      limitation: 'A API de dados do YouTube publica vídeos, não imagens avulsas.',
    }),
    publishCarousel: NAO_SUPORTADO,
    publishStory: NAO_SUPORTADO,
    publishText: NAO_SUPORTADO,
    scheduleNatively: cap('SUPPORTED', {
      limitation: 'status.publishAt exige privacyStatus=private no envio.',
    }),
    readAccountMetrics: cap('PARTIAL', {
      limitation:
        'A Data API dá contadores acumulados. Alcance e retenção exigem a YouTube ' +
        'Analytics API, que é outro escopo de OAuth.',
    }),
    readPostMetrics: cap('SUPPORTED'),
    readComments: cap('SUPPORTED'),
    replyToComments: cap('SUPPORTED', {
      limitation: 'Exige o escopo youtube.force-ssl, não pedido na conexão padrão.',
    }),
    readDirectMessages: cap('UNSUPPORTED', {
      limitation: 'O YouTube não expõe mensagens diretas por API.',
    }),
    deletePost: cap('SUPPORTED'),
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
      maxSizeBytes: 137_438_953_472, // 128 GB
      maxDurationMs: 43_200_000, // 12 h (contas verificadas)
      aspectRatios: [],
      aspectRatioTolerance: 0.02,
      maxItemsPerPost: 1,
    },
    mediaRequired: true,
    maxTitleLength: 100,
    titleRequired: true,
    maxCaptionLength: 5000,
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
          'Google Cloud, compartilhado por todos os clientes do SaaS. Aumento pelo ' +
          'Quota extension request form.',
      },
      {
        scope: 'APP',
        unit: 'UNITS',
        limit: 10_000,
        costPerPublish: 2,
        windowHours: 24,
        resetsAtUtcHour: 7,
        note: 'Bucket geral: demais endpoints somados, também por projeto.',
      },
    ],
  },
  duplicateContentPolicy: {
    policy: 'RESTRICTED',
    explanation:
      'O YouTube não proíbe o mesmo vídeo em canais diferentes, mas as políticas de spam ' +
      'e conteúdo repetitivo podem penalizar canais que republicam material idêntico sem ' +
      'valor agregado.',
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
          'Projetos sem auditoria de conformidade publicam sempre como privado, mesmo ' +
          'que outra opção seja escolhida aqui.',
      },
      {
        key: 'categoryId',
        label: 'Categoria',
        type: 'SELECT',
        required: true,
        // Varia por região; vem de videoCategories.list.
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
        helpText: 'Declaração exigida pela COPPA. O YouTube rejeita o upload sem ela.',
      },
    ],
  },
  oauthScopes: [
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube.readonly',
  ],
  docsUrl: 'https://developers.google.com/youtube/v3/docs/videos/insert',
  credentialEnvVars: ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET'],
};

// ===========================================================================
//  INSTAGRAM — Fase 6
//
//  Fonte (2026-09-10):
//    https://developers.facebook.com/docs/instagram-platform/content-publishing
//
//  Exige conta profissional (Business/Creator) vinculada a uma Página, mídia
//  hospedada em URL pública e Page Publishing Authorization concluída.
//  Limite documentado: 100 publicações por conta em 24h (carrossel conta 1).
// ===========================================================================

const instagram: PlatformDefinition = {
  key: 'INSTAGRAM',
  displayName: 'Instagram',
  isAvailable: false,
  unavailableReason:
    'A integração com o Instagram ainda não foi implementada neste sistema (Fase 6). ' +
    'As capacidades abaixo vêm da documentação oficial da Meta e serão ativadas quando ' +
    'o adapter for escrito e o app passar pela revisão da Meta.',
  capabilities: {
    publishImage: cap('SUPPORTED', {
      requiresAppReview: true,
      requiresBusinessAccount: true,
      limitation: 'Somente JPEG. A mídia precisa estar em URL pública acessível pela Meta.',
    }),
    publishVideo: cap('SUPPORTED', {
      requiresAppReview: true,
      requiresBusinessAccount: true,
      limitation: 'Vídeos são publicados como Reels.',
    }),
    publishCarousel: cap('SUPPORTED', {
      requiresAppReview: true,
      requiresBusinessAccount: true,
      limitation: 'Até 10 itens; o carrossel conta como 1 publicação na cota.',
    }),
    publishStory: cap('SUPPORTED', { requiresAppReview: true, requiresBusinessAccount: true }),
    publishText: cap('UNSUPPORTED', {
      limitation: 'O Instagram exige mídia em toda publicação.',
    }),
    scheduleNatively: cap('UNSUPPORTED', {
      limitation: 'Não há agendamento nativo na API; o agendamento é da nossa fila.',
    }),
    readAccountMetrics: cap('SUPPORTED', { requiresAppReview: true, requiresBusinessAccount: true }),
    readPostMetrics: cap('SUPPORTED', { requiresAppReview: true, requiresBusinessAccount: true }),
    readComments: cap('SUPPORTED', { requiresAppReview: true, requiresBusinessAccount: true }),
    replyToComments: cap('SUPPORTED', { requiresAppReview: true, requiresBusinessAccount: true }),
    readDirectMessages: cap('PARTIAL', {
      requiresAppReview: true,
      requiresBusinessAccount: true,
      limitation: 'Exige a Messenger API for Instagram, com revisão à parte.',
    }),
    deletePost: cap('UNSUPPORTED', {
      limitation: 'A API de publicação não expõe exclusão de mídia publicada.',
    }),
  },
  mediaRequirements: {
    image: {
      mimeTypes: ['image/jpeg'],
      maxSizeBytes: 8_388_608, // 8 MB
      aspectRatios: [
        [4, 5],
        [1, 1],
        [1.91, 1],
      ],
      aspectRatioTolerance: 0.02,
      maxItemsPerPost: 10,
    },
    video: {
      mimeTypes: ['video/mp4', 'video/quicktime'],
      maxSizeBytes: 1_073_741_824, // 1 GB
      maxDurationMs: 900_000, // 15 min (Reels)
      minDurationMs: 3000,
      aspectRatios: [[9, 16]],
      aspectRatioTolerance: 0.05,
      maxItemsPerPost: 10,
    },
    mediaRequired: true,
    maxCaptionLength: 2200,
    titleRequired: false,
    maxHashtags: 30,
  },
  quotaRules: {
    verified: true,
    sourceUrl: 'https://developers.facebook.com/docs/instagram-platform/content-publishing',
    rules: [
      {
        scope: 'ACCOUNT',
        unit: 'POSTS',
        limit: 100,
        costPerPublish: 1,
        windowHours: 24,
        resetsAtUtcHour: 0,
        note:
          'Janela móvel de 24h POR CONTA. Carrossel conta como 1. O consumo real pode ' +
          'ser consultado em GET /content_publishing_limit.',
      },
    ],
  },
  duplicateContentPolicy: {
    policy: 'RESTRICTED',
    explanation:
      'A Meta não proíbe explicitamente a mesma mídia em contas diferentes, mas as ' +
      'políticas de spam e comportamento inautêntico penalizam publicação repetitiva ' +
      'coordenada.',
    policyUrl: 'https://transparency.meta.com/policies/community-standards/spam/',
    similarityThreshold: 0.95,
  },
  requiredUxFields: { fields: [], mustShowTargetProfile: true },
  oauthScopes: ['instagram_business_basic', 'instagram_business_content_publish'],
  docsUrl: 'https://developers.facebook.com/docs/instagram-platform/content-publishing',
  credentialEnvVars: ['META_APP_ID', 'META_APP_SECRET'],
};

// ===========================================================================
//  FACEBOOK — Fase 6
//
//  Fonte (2026-09-10): https://developers.facebook.com/docs/pages-api/posts
//
//  Único caso com agendamento NATIVO documentado: `scheduled_publish_time`
//  entre 10 minutos e 30 dias à frente.
// ===========================================================================

const facebook: PlatformDefinition = {
  key: 'FACEBOOK',
  displayName: 'Facebook',
  isAvailable: false,
  unavailableReason:
    'A integração com o Facebook ainda não foi implementada neste sistema (Fase 6). ' +
    'As capacidades abaixo vêm da documentação oficial da Meta.',
  capabilities: {
    publishText: cap('SUPPORTED', { requiresAppReview: true, requiresBusinessAccount: true }),
    publishImage: cap('SUPPORTED', { requiresAppReview: true, requiresBusinessAccount: true }),
    publishVideo: cap('SUPPORTED', {
      requiresAppReview: true,
      requiresBusinessAccount: true,
      limitation: 'Vídeo usa a Video API, com escopo publish_video.',
    }),
    publishCarousel: cap('PARTIAL', {
      requiresAppReview: true,
      limitation: 'Não há carrossel orgânico direto; múltiplas fotos viram um álbum.',
    }),
    publishStory: cap('PARTIAL', {
      requiresAppReview: true,
      limitation: 'Stories de Página têm API própria, com requisitos distintos.',
    }),
    scheduleNatively: cap('SUPPORTED', {
      limitation:
        'scheduled_publish_time precisa ficar entre 10 minutos e 30 dias a partir da ' +
        'chamada — fora dessa janela a API recusa.',
    }),
    readAccountMetrics: cap('SUPPORTED', { requiresAppReview: true }),
    readPostMetrics: cap('SUPPORTED', { requiresAppReview: true }),
    readComments: cap('SUPPORTED', { requiresAppReview: true }),
    replyToComments: cap('SUPPORTED', { requiresAppReview: true }),
    readDirectMessages: cap('PARTIAL', {
      requiresAppReview: true,
      limitation: 'Exige a Messenger Platform, com revisão à parte.',
    }),
    deletePost: cap('SUPPORTED', { requiresAppReview: true }),
  },
  mediaRequirements: {
    image: {
      mimeTypes: ['image/jpeg', 'image/png', 'image/gif'],
      maxSizeBytes: 4_194_304,
      aspectRatios: [],
      aspectRatioTolerance: 0.02,
      maxItemsPerPost: 10,
    },
    video: {
      mimeTypes: ['video/mp4', 'video/quicktime'],
      maxSizeBytes: 10_737_418_240, // 10 GB
      maxDurationMs: 14_400_000, // 4 h
      aspectRatios: [],
      aspectRatioTolerance: 0.05,
      maxItemsPerPost: 1,
    },
    // Publicação só com texto é válida numa Página.
    mediaRequired: false,
    maxCaptionLength: 63_206,
    titleRequired: false,
  },
  quotaRules: {
    // A documentação de Pages API > Posts não publica um número de limite de
    // publicação; o rate limit da Graph API é por app e calculado
    // dinamicamente. Sem número confirmado, o validador só avisa.
    verified: false,
    sourceUrl: 'https://developers.facebook.com/docs/graph-api/overview/rate-limiting',
    rules: [],
  },
  duplicateContentPolicy: {
    policy: 'RESTRICTED',
    explanation:
      'A Meta não proíbe explicitamente o mesmo conteúdo em Páginas diferentes, mas as ' +
      'políticas de spam penalizam publicação repetitiva coordenada.',
    policyUrl: 'https://transparency.meta.com/policies/community-standards/spam/',
    similarityThreshold: 0.95,
  },
  requiredUxFields: { fields: [], mustShowTargetProfile: true },
  oauthScopes: ['pages_manage_posts', 'pages_read_engagement', 'publish_video'],
  docsUrl: 'https://developers.facebook.com/docs/pages-api/posts',
  credentialEnvVars: ['META_APP_ID', 'META_APP_SECRET'],
};

// ===========================================================================
//  TIKTOK — Fase 7
//
//  Fontes (2026-09-10):
//    https://developers.tiktok.com/doc/content-sharing-guidelines
//    https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post
//
//  É a plataforma com mais exigências de UX, e a SPEC seção 6.1 cita
//  justamente ela: mostrar o perfil de destino, privacidade escolhida pelo
//  usuário SEM valor padrão (entre as opções retornadas por creator_info) e
//  consentimento explícito antes do envio. Selecionar um grupo não pula nada
//  disso — os campos são coletados por conta.
// ===========================================================================

const tiktok: PlatformDefinition = {
  key: 'TIKTOK',
  displayName: 'TikTok',
  isAvailable: false,
  unavailableReason:
    'A integração com o TikTok ainda não foi implementada neste sistema (Fase 7). ' +
    'Além do adapter, o Direct Post exige auditoria do aplicativo pelo TikTok: sem ela, ' +
    'as publicações ficam restritas a SELF_ONLY e a no máximo 5 usuários por 24h.',
  capabilities: {
    publishVideo: cap('SUPPORTED', {
      requiresAppReview: true,
      limitation:
        'Sem auditoria do app, todo conteúdo sai como SELF_ONLY (privado) e o cliente ' +
        'fica limitado a 5 usuários publicando em 24h, todos com conta privada.',
    }),
    publishImage: cap('SUPPORTED', {
      requiresAppReview: true,
      limitation: 'Fotos usam o endpoint de photo post, distinto do de vídeo.',
    }),
    publishCarousel: cap('PARTIAL', {
      requiresAppReview: true,
      limitation: 'Múltiplas fotos num photo post; não há carrossel de vídeos.',
    }),
    publishStory: NAO_SUPORTADO,
    publishText: cap('UNSUPPORTED', { limitation: 'O TikTok exige mídia.' }),
    scheduleNatively: cap('UNSUPPORTED', {
      limitation: 'Não há agendamento nativo; o agendamento é da nossa fila.',
    }),
    readAccountMetrics: cap('PARTIAL', {
      requiresAppReview: true,
      limitation: 'Métricas exigem o escopo user.info.stats, com revisão à parte.',
    }),
    readPostMetrics: cap('PARTIAL', { requiresAppReview: true }),
    readComments: cap('PARTIAL', {
      requiresAppReview: true,
      limitation: 'Depende de escopos de comentário liberados caso a caso.',
    }),
    replyToComments: cap('UNKNOWN'),
    readDirectMessages: cap('UNSUPPORTED'),
    deletePost: cap('UNSUPPORTED', {
      limitation: 'A Content Posting API não expõe exclusão.',
    }),
  },
  mediaRequirements: {
    video: {
      mimeTypes: ['video/mp4', 'video/quicktime', 'video/webm'],
      maxSizeBytes: 4_294_967_296, // 4 GB
      maxDurationMs: 600_000, // 10 min
      minDurationMs: 3000,
      aspectRatios: [],
      aspectRatioTolerance: 0.05,
      maxItemsPerPost: 1,
    },
    image: {
      mimeTypes: ['image/jpeg', 'image/webp'],
      maxSizeBytes: 20_971_520,
      aspectRatios: [],
      aspectRatioTolerance: 0.05,
      maxItemsPerPost: 35,
    },
    mediaRequired: true,
    maxCaptionLength: 2200,
    titleRequired: true,
    maxTitleLength: 2200,
    maxHashtags: 30,
  },
  quotaRules: {
    // "tipicamente ~15 publicações por dia por criador" é o que a
    // documentação indica, mas o número varia por conta — então NÃO é
    // tratado como limite confirmado.
    verified: false,
    sourceUrl: 'https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post',
    rules: [
      {
        scope: 'ACCOUNT',
        unit: 'POSTS',
        limit: 15,
        costPerPublish: 1,
        windowHours: 24,
        resetsAtUtcHour: 0,
        note:
          'Aproximação: o TikTok informa que o teto varia por criador. Como não é um ' +
          'número fixo documentado, o sistema apenas avisa e deixa a plataforma decidir.',
      },
    ],
  },
  duplicateContentPolicy: {
    policy: 'RESTRICTED',
    explanation:
      'O TikTok penaliza conteúdo duplicado e não original nas diretrizes da comunidade, ' +
      'sem proibir explicitamente publicar em contas próprias diferentes.',
    policyUrl: 'https://www.tiktok.com/community-guidelines',
    similarityThreshold: 0.95,
  },
  requiredUxFields: {
    // Exigências literais das Content Sharing Guidelines.
    mustShowTargetProfile: true,
    guidelinesUrl: 'https://developers.tiktok.com/doc/content-sharing-guidelines',
    fields: [
      {
        key: 'privacy_level',
        label: 'Quem pode ver este vídeo',
        type: 'SELECT',
        required: true,
        // As opções vêm de creator_info e variam por conta: uma conta privada
        // não oferece PUBLIC_TO_EVERYONE. Fixar a lista seria inventar API.
        optionsFromApi: true,
        options: [],
        helpText:
          'Exigência do TikTok: a escolha é do usuário e NÃO pode ter valor padrão. ' +
          'As opções vêm da API para cada conta.',
      },
      {
        key: 'disable_comment',
        label: 'Desativar comentários',
        type: 'BOOLEAN',
        required: false,
        optionsFromApi: false,
        options: [],
      },
      {
        key: 'disable_duet',
        label: 'Desativar Duet',
        type: 'BOOLEAN',
        required: false,
        optionsFromApi: false,
        options: [],
      },
      {
        key: 'disable_stitch',
        label: 'Desativar Stitch',
        type: 'BOOLEAN',
        required: false,
        optionsFromApi: false,
        options: [],
      },
      {
        key: 'brand_content_toggle',
        label: 'Conteúdo de marca (Branded Content)',
        type: 'BOOLEAN',
        required: false,
        optionsFromApi: false,
        options: [],
        helpText: 'Marque se o conteúdo promove uma marca terceira mediante pagamento.',
      },
      {
        key: 'brand_organic_toggle',
        label: 'Promove a sua própria marca',
        type: 'BOOLEAN',
        required: false,
        optionsFromApi: false,
        options: [],
      },
      {
        key: 'music_usage_consent',
        label: 'Confirmação de uso de música',
        type: 'CONSENT',
        required: true,
        optionsFromApi: false,
        options: [],
        consentText:
          'Ao publicar, você concorda com a Confirmação de Uso de Música do TikTok — e, ' +
          'se marcou conteúdo de marca, também com a Política de Conteúdo de Marca.',
      },
    ],
  },
  oauthScopes: ['user.info.basic', 'video.publish'],
  docsUrl: 'https://developers.tiktok.com/doc/content-posting-api-get-started',
  credentialEnvVars: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'],
};

// ===========================================================================
//  X — Fase 9
//
//  Fontes (2026-09-10):
//    https://docs.x.com/developer-terms/policy
//    https://help.x.com/en/rules-and-policies/x-automation
//
//  ESTE É O CASO DA SPEC SEÇÃO 6.1 QUE EXIGE BLOQUEIO.
//  A regra de automação do X é literal: "You may not post duplicative or
//  substantially similar posts on one account or over multiple accounts you
//  operate." Por isso `policy: FORBIDDEN` — o validador BARRA o agendamento
//  do mesmo conteúdo para duas contas do X, e explica o motivo.
// ===========================================================================

const x: PlatformDefinition = {
  key: 'X',
  displayName: 'X',
  isAvailable: false,
  unavailableReason:
    'A integração com o X ainda não foi implementada neste sistema (Fase 9). ' +
    'Além do adapter, o acesso de escrita à API do X é pago — é preciso um plano ' +
    'com permissão de publicação.',
  capabilities: {
    publishText: cap('SUPPORTED', {
      limitation: 'O acesso de escrita exige plano pago da API do X.',
    }),
    publishImage: cap('SUPPORTED', {
      limitation: 'Upload de mídia em endpoint separado, com plano pago.',
    }),
    publishVideo: cap('SUPPORTED', {
      limitation: 'Upload em pedaços (chunked), com plano pago.',
    }),
    publishCarousel: cap('PARTIAL', { limitation: 'Até 4 imagens por post.' }),
    publishStory: NAO_SUPORTADO,
    scheduleNatively: cap('UNSUPPORTED'),
    readAccountMetrics: cap('PARTIAL', {
      limitation: 'Métricas detalhadas dependem do nível do plano contratado.',
    }),
    readPostMetrics: cap('PARTIAL', {
      limitation: 'Métricas de post dependem do nível do plano contratado.',
    }),
    readComments: cap('PARTIAL', { limitation: 'Busca de respostas consome cota de leitura.' }),
    replyToComments: cap('SUPPORTED', { limitation: 'Uma resposta é um post; consome cota.' }),
    readDirectMessages: cap('PARTIAL', { limitation: 'Exige escopo e plano específicos.' }),
    deletePost: cap('SUPPORTED'),
  },
  mediaRequirements: {
    image: {
      mimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
      maxSizeBytes: 5_242_880, // 5 MB
      aspectRatios: [],
      aspectRatioTolerance: 0.05,
      maxItemsPerPost: 4,
    },
    video: {
      mimeTypes: ['video/mp4'],
      maxSizeBytes: 536_870_912, // 512 MB
      maxDurationMs: 140_000,
      aspectRatios: [],
      aspectRatioTolerance: 0.05,
      maxItemsPerPost: 1,
    },
    // Post só com texto é o caso padrão do X.
    mediaRequired: false,
    maxCaptionLength: 280,
    titleRequired: false,
  },
  quotaRules: {
    // O limite de posts depende do plano contratado e não é um número
    // universal documentado — então não é tratado como confirmado.
    verified: false,
    sourceUrl: 'https://docs.x.com/x-api',
    rules: [],
  },
  duplicateContentPolicy: {
    policy: 'FORBIDDEN',
    explanation:
      'A política de automação do X proíbe publicar conteúdo duplicado ou ' +
      'substancialmente semelhante numa mesma conta ou em várias contas operadas pela ' +
      'mesma pessoa. Violar isso pode suspender as contas envolvidas e o acesso à API.',
    policyUrl: 'https://help.x.com/en/rules-and-policies/x-automation',
    similarityThreshold: 0.9,
  },
  requiredUxFields: { fields: [], mustShowTargetProfile: true },
  oauthScopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'],
  docsUrl: 'https://docs.x.com/x-api',
  credentialEnvVars: ['X_CLIENT_ID', 'X_CLIENT_SECRET'],
};

// ===========================================================================
//  KWAI — Fase 10
//
//  Verificação exigida pela SPEC seção 3, feita em 2026-09-10:
//
//  Não existe API oficial pública de PUBLICAÇÃO de conteúdo para terceiros.
//  O que o Kwai documenta é a API de ANÚNCIOS (escopos ad_mapi_campaign_*,
//  ad_mapi_unit_*, ad_mapi_creative_*, ad_mapi_material_*, ad_mapi_report) e
//  um Kwai OpenID Connect, com acesso concedido caso a caso por solicitação
//  a Kwaiapi@kuaishou.com. Nada disso publica vídeo orgânico numa conta.
//
//  Conclusão: o Kwai SAI da promessa da v1 e aparece na UI como
//  indisponível. Scraping ou automação do app não são alternativas
//  aceitáveis (SPEC seção 19).
// ===========================================================================

const kwai: PlatformDefinition = {
  key: 'KWAI',
  displayName: 'Kwai',
  isAvailable: false,
  unavailableReason:
    'Este recurso não está disponível pela API oficial desta plataforma. Em consulta ' +
    'feita em 10/09/2026, o Kwai não publica uma API de publicação de conteúdo para ' +
    'terceiros — o que existe documentado é a API de anúncios, com acesso concedido ' +
    'caso a caso mediante solicitação. Publicar por scraping ou automação do aplicativo ' +
    'não é uma alternativa aceitável neste sistema.',
  capabilities: {
    publishVideo: cap('UNSUPPORTED', {
      limitation: 'Sem API oficial de publicação para terceiros.',
    }),
    publishImage: cap('UNSUPPORTED'),
    publishCarousel: NAO_SUPORTADO,
    publishStory: NAO_SUPORTADO,
    publishText: NAO_SUPORTADO,
    scheduleNatively: NAO_SUPORTADO,
    readAccountMetrics: cap('UNKNOWN', {
      limitation: 'Métricas orgânicas não documentadas publicamente para terceiros.',
    }),
    readPostMetrics: cap('UNKNOWN'),
    readComments: cap('UNKNOWN'),
    replyToComments: cap('UNKNOWN'),
    readDirectMessages: NAO_SUPORTADO,
    deletePost: NAO_SUPORTADO,
  },
  mediaRequirements: { mediaRequired: true, titleRequired: false },
  quotaRules: { verified: false, rules: [] },
  duplicateContentPolicy: {
    policy: 'RESTRICTED',
    explanation:
      'A política do Kwai sobre conteúdo repetido não foi verificada, porque não há ' +
      'integração de publicação disponível.',
    similarityThreshold: 0.9,
  },
  requiredUxFields: { fields: [], mustShowTargetProfile: false },
  oauthScopes: [],
  docsUrl: 'https://www.kwai.com/third-party',
  credentialEnvVars: ['KWAI_CLIENT_ID', 'KWAI_CLIENT_SECRET'],
};

// ===========================================================================

export const PLATFORM_REGISTRY: Record<PlatformKey, PlatformDefinition> = {
  YOUTUBE: youtube,
  INSTAGRAM: instagram,
  FACEBOOK: facebook,
  TIKTOK: tiktok,
  X: x,
  KWAI: kwai,
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
