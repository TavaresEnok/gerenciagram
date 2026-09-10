import { z } from 'zod';

/**
 * Esquemas das capacidades declaradas de cada rede (SPEC seções 3 e 4).
 *
 * Estes objetos são persistidos em `SocialPlatform` e são a ÚNICA fonte das
 * validações por destino no agendamento (seção 6.1). Nenhuma regra de
 * plataforma pode viver espalhada em `if (platform === 'TIKTOK')` pelo código.
 */

export const PLATFORM_KEYS = [
  'INSTAGRAM',
  'FACEBOOK',
  'TIKTOK',
  'YOUTUBE',
  'X',
  'KWAI',
] as const;

export type PlatformKey = (typeof PLATFORM_KEYS)[number];

export const platformKeySchema = z.enum(PLATFORM_KEYS);

// ---------------------------------------------------------------------------
//  Capacidades
// ---------------------------------------------------------------------------

/** Grau de suporte via API OFICIAL. Alimenta a matriz do SOCIAL_INTEGRATIONS.md. */
export const supportLevelSchema = z.enum(['SUPPORTED', 'PARTIAL', 'UNSUPPORTED', 'UNKNOWN']);
export type SupportLevel = z.infer<typeof supportLevelSchema>;

export const capabilitySchema = z.object({
  level: supportLevelSchema,
  /** Exige revisão/aprovação do app pela plataforma antes de funcionar. */
  requiresAppReview: z.boolean().default(false),
  /** Exige que a conta seja business/creator. */
  requiresBusinessAccount: z.boolean().default(false),
  /** Limitação conhecida, em português, exibível ao usuário. */
  limitation: z.string().optional(),
});
export type Capability = z.infer<typeof capabilitySchema>;

export const platformCapabilitiesSchema = z.object({
  publishImage: capabilitySchema,
  publishVideo: capabilitySchema,
  publishCarousel: capabilitySchema,
  publishStory: capabilitySchema,
  publishText: capabilitySchema,
  scheduleNatively: capabilitySchema,
  readAccountMetrics: capabilitySchema,
  readPostMetrics: capabilitySchema,
  readComments: capabilitySchema,
  replyToComments: capabilitySchema,
  readDirectMessages: capabilitySchema,
  deletePost: capabilitySchema,
});
export type PlatformCapabilities = z.infer<typeof platformCapabilitiesSchema>;

export type CapabilityName = keyof PlatformCapabilities;

// ---------------------------------------------------------------------------
//  Requisitos de mídia
// ---------------------------------------------------------------------------

export const mediaSpecSchema = z.object({
  /** MIME types aceitos pela plataforma. */
  mimeTypes: z.array(z.string()).default([]),
  maxSizeBytes: z.number().int().positive().optional(),
  minDurationMs: z.number().int().nonnegative().optional(),
  maxDurationMs: z.number().int().positive().optional(),
  minWidth: z.number().int().positive().optional(),
  minHeight: z.number().int().positive().optional(),
  maxWidth: z.number().int().positive().optional(),
  maxHeight: z.number().int().positive().optional(),
  /** Proporções aceitas como [largura, altura], ex.: [[9,16],[1,1]]. */
  aspectRatios: z.array(z.tuple([z.number(), z.number()])).default([]),
  /** Tolerância na comparação de proporção (imprecisão de encoder). */
  aspectRatioTolerance: z.number().default(0.02),
  maxItemsPerPost: z.number().int().positive().default(1),
});
export type MediaSpec = z.infer<typeof mediaSpecSchema>;

export const mediaRequirementsSchema = z.object({
  image: mediaSpecSchema.optional(),
  video: mediaSpecSchema.optional(),
  /** Mídia é obrigatória para publicar nesta rede? (X aceita só texto) */
  mediaRequired: z.boolean().default(true),
  maxCaptionLength: z.number().int().positive().optional(),
  maxTitleLength: z.number().int().positive().optional(),
  titleRequired: z.boolean().default(false),
  maxHashtags: z.number().int().nonnegative().optional(),
});
export type MediaRequirements = z.infer<typeof mediaRequirementsSchema>;

// ---------------------------------------------------------------------------
//  Cotas
// ---------------------------------------------------------------------------

/**
 * `scope` é a distinção que a SPEC (seção 12) manda tratar com atenção:
 *
 *  ACCOUNT — limite por conta conectada (ex.: N posts/dia por perfil).
 *  APP     — limite do PROJETO/aplicativo, compartilhado por TODOS os
 *            clientes do SaaS. É o caso do YouTube: a cota é do projeto no
 *            Google Cloud, então um cliente pode esgotar a cota dos outros.
 */
export const quotaRuleSchema = z.object({
  scope: z.enum(['ACCOUNT', 'APP']),
  /** Unidade contada: publicações ou "unidades de cota" ponderadas. */
  unit: z.enum(['POSTS', 'UNITS']),
  limit: z.number().int().positive(),
  /** Custo de UMA publicação, na unidade acima. */
  costPerPublish: z.number().int().nonnegative().default(1),
  windowHours: z.number().int().positive().default(24),
  /** Hora UTC em que a janela reseta (YouTube reseta à meia-noite PT). */
  resetsAtUtcHour: z.number().int().min(0).max(23).default(0),
  note: z.string().optional(),
});
export type QuotaRule = z.infer<typeof quotaRuleSchema>;

export const quotaRulesSchema = z.object({
  rules: z.array(quotaRuleSchema).default([]),
  /**
   * false quando o limite real não foi confirmado na documentação oficial.
   * Nesse caso o sistema avisa em vez de bloquear — a SPEC (regra 6) proíbe
   * inventar número de API.
   */
  verified: z.boolean().default(false),
  sourceUrl: z.string().optional(),
});
export type QuotaRules = z.infer<typeof quotaRulesSchema>;

// ---------------------------------------------------------------------------
//  Política de conteúdo duplicado entre contas
// ---------------------------------------------------------------------------

export const duplicateContentPolicySchema = z.object({
  /**
   * ALLOWED    — pode publicar igual em várias contas.
   * RESTRICTED — não é proibido, mas há risco (spam/shadowban): avisar.
   * FORBIDDEN  — a plataforma proíbe: bloquear no agendamento.
   */
  policy: z.enum(['ALLOWED', 'RESTRICTED', 'FORBIDDEN']),
  /** Explicação exibida ao usuário quando o agendamento é bloqueado/avisado. */
  explanation: z.string(),
  policyUrl: z.string().optional(),
  /**
   * Considerar "substancialmente semelhante" acima desta similaridade de
   * texto (0..1). Só usado quando policy = FORBIDDEN.
   */
  similarityThreshold: z.number().min(0).max(1).default(0.9),
});
export type DuplicateContentPolicy = z.infer<typeof duplicateContentPolicySchema>;

// ---------------------------------------------------------------------------
//  Campos de UX obrigatórios pela plataforma
// ---------------------------------------------------------------------------

/**
 * Telas/campos que a plataforma EXIGE no fluxo de publicação — não são
 * opcionais nem podem ser pulados porque o usuário selecionou um grupo
 * (SPEC seção 6.1). O compositor renderiza estes campos por conta.
 */
export const requiredUxFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(['SELECT', 'BOOLEAN', 'TEXT', 'CONSENT']),
  required: z.boolean().default(true),
  /**
   * Para SELECT: quando true, as opções NÃO são fixas — precisam ser buscadas
   * na API no momento da composição (ex.: níveis de privacidade do TikTok,
   * que variam por conta). Opções hardcoded aqui seriam invenção de API.
   */
  optionsFromApi: z.boolean().default(false),
  options: z.array(z.object({ value: z.string(), label: z.string() })).default([]),
  helpText: z.string().optional(),
  /** Texto exato do consentimento, quando type = CONSENT. */
  consentText: z.string().optional(),
});
export type RequiredUxField = z.infer<typeof requiredUxFieldSchema>;

export const requiredUxFieldsSchema = z.object({
  fields: z.array(requiredUxFieldSchema).default([]),
  /** Exibir o perfil de destino na tela de confirmação (exigência do TikTok). */
  mustShowTargetProfile: z.boolean().default(false),
  guidelinesUrl: z.string().optional(),
});
export type RequiredUxFields = z.infer<typeof requiredUxFieldsSchema>;

// ---------------------------------------------------------------------------
//  Definição completa de uma plataforma
// ---------------------------------------------------------------------------

export const platformDefinitionSchema = z.object({
  key: platformKeySchema,
  displayName: z.string(),
  isAvailable: z.boolean(),
  unavailableReason: z.string().nullable().default(null),
  capabilities: platformCapabilitiesSchema,
  mediaRequirements: mediaRequirementsSchema,
  quotaRules: quotaRulesSchema,
  duplicateContentPolicy: duplicateContentPolicySchema,
  requiredUxFields: requiredUxFieldsSchema,
  oauthScopes: z.array(z.string()).default([]),
  docsUrl: z.string().nullable().default(null),
  /** Nomes das variáveis de ambiente que precisam estar preenchidas. */
  credentialEnvVars: z.array(z.string()).default([]),
});
export type PlatformDefinition = z.infer<typeof platformDefinitionSchema>;
