import type {
  MediaSpec,
  PlatformDefinition,
  PlatformKey,
} from '../platform/capabilities.js';
import { groupBySimilarity } from './similarity.js';

/**
 * Validação por destino NO MOMENTO DO AGENDAMENTO (SPEC seção 6.1).
 *
 * O ponto inteiro deste módulo é a frase da especificação: "nunca deixar para
 * descobrir às 3h da manhã, quando o job roda". Tudo que dá para saber antes
 * — formato de mídia, campo obrigatório faltando, cota estourada, regra de
 * conteúdo duplicado — é decidido aqui, com o usuário olhando a tela.
 *
 * O validador é uma função pura: recebe o estado, devolve problemas. Não lê
 * banco, não chama API, não persiste nada. É isso que o torna testável contra
 * os cenários obrigatórios da SPEC seção 21.
 */

export type IssueSeverity = 'ERROR' | 'WARNING';

export interface ValidationIssue {
  code: string;
  severity: IssueSeverity;
  message: string;
  /** Campo do compositor ao qual o problema se refere, quando aplicável. */
  field?: string;
}

export interface TargetMediaInput {
  mediaAssetId: string;
  filename: string;
  mimeType: string;
  type: 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'AUDIO';
  sizeBytes: number;
  durationMs?: number | null;
  width?: number | null;
  height?: number | null;
  processingStatus: 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';
}

export interface TargetValidationInput {
  targetKey: string;
  accountId: string;
  /** Nome real do perfil, para a mensagem citar a conta certa. */
  accountLabel: string;
  platform: PlatformKey;
  accountStatus: 'ACTIVE' | 'NEEDS_RECONNECT' | 'DISCONNECTED' | 'SUSPENDED';
  accountTimezone: string;

  title?: string | null;
  body: string;
  hashtags: string[];
  platformFields: Record<string, unknown>;
  media: TargetMediaInput[];

  scheduledAt: Date | null;

  /**
   * Conteúdo gerado por IA ainda não revisado por uma pessoa (SPEC seção 6).
   * Bloqueia TODOS os destinos no agendamento, não só na hora de publicar:
   * o usuário descobre enquanto olha a tela, não às 3h da manhã.
   */
  aiNeedsReview?: boolean;
}

/** Consumo já registrado, por escopo, para o dia do agendamento. */
export interface QuotaSnapshot {
  /** chave: `${platform}:${accountId}` */
  accountUsage: Map<string, { count: number; units: number }>;
  /** chave: `${platform}` */
  appUsage: Map<string, { count: number; units: number }>;
  /**
   * Quantos destinos deste mesmo agendamento já foram contados para cada
   * chave — o lote precisa ser considerado junto, senão 20 destinos passam
   * individualmente e estouram a cota em conjunto.
   */
}

export interface ValidationContext {
  definitions: Record<PlatformKey, PlatformDefinition>;
  /** Plataformas com credenciais de app preenchidas neste ambiente. */
  configuredPlatforms: Set<PlatformKey>;
  quota: QuotaSnapshot;
  now: Date;
}

export interface TargetValidationResult {
  targetKey: string;
  accountId: string;
  accountLabel: string;
  issues: ValidationIssue[];
  /** false quando há ao menos um ERROR — o destino não pode ser agendado. */
  canSchedule: boolean;
}

export interface BatchValidationResult {
  targets: TargetValidationResult[];
  /** true quando TODOS os destinos podem ser agendados. */
  allValid: boolean;
  /** Destinos válidos, para o agendamento parcial. */
  schedulableTargetKeys: string[];
}

// ---------------------------------------------------------------------------

export function validateTargets(
  targets: TargetValidationInput[],
  ctx: ValidationContext,
): BatchValidationResult {
  const issuesByTarget = new Map<string, ValidationIssue[]>();
  for (const target of targets) issuesByTarget.set(target.targetKey, []);

  const push = (targetKey: string, issue: ValidationIssue) => {
    issuesByTarget.get(targetKey)?.push(issue);
  };

  // --- Checagens que valem por destino isolado ---
  for (const target of targets) {
    const def = ctx.definitions[target.platform];
    if (!def) {
      push(target.targetKey, {
        code: 'PLATFORM_UNKNOWN',
        severity: 'ERROR',
        message: `Plataforma desconhecida: ${target.platform}.`,
      });
      continue;
    }

    validateAvailability(target, def, ctx, push);
    validateAccountStatus(target, push);
    validateSchedule(target, ctx, push);
    validateAiReview(target, push);
    validateTextFields(target, def, push);
    validateMedia(target, def, push);
    validateRequiredUxFields(target, def, push);
  }

  // --- Checagens que só existem no conjunto ---
  validateDuplicateContent(targets, ctx, push);
  validateQuota(targets, ctx, push);

  const results: TargetValidationResult[] = targets.map((target) => {
    const issues = issuesByTarget.get(target.targetKey) ?? [];
    return {
      targetKey: target.targetKey,
      accountId: target.accountId,
      accountLabel: target.accountLabel,
      issues,
      canSchedule: !issues.some((i) => i.severity === 'ERROR'),
    };
  });

  return {
    targets: results,
    allValid: results.every((r) => r.canSchedule),
    schedulableTargetKeys: results.filter((r) => r.canSchedule).map((r) => r.targetKey),
  };
}

type Push = (targetKey: string, issue: ValidationIssue) => void;

// ---------------------------------------------------------------------------

function validateAvailability(
  target: TargetValidationInput,
  def: PlatformDefinition,
  ctx: ValidationContext,
  push: Push,
): void {
  if (!def.isAvailable) {
    push(target.targetKey, {
      code: 'PLATFORM_UNAVAILABLE',
      severity: 'ERROR',
      message:
        def.unavailableReason ??
        `Este recurso não está disponível pela API oficial desta plataforma (${def.displayName}).`,
    });
    return;
  }

  if (!ctx.configuredPlatforms.has(target.platform)) {
    push(target.targetKey, {
      code: 'PLATFORM_NOT_CONFIGURED',
      severity: 'ERROR',
      message:
        `A integração com ${def.displayName} não está configurada neste ambiente ` +
        `(faltam as credenciais do aplicativo). Nenhuma publicação será feita.`,
    });
    return;
  }

  // A rede publica o tipo de mídia que este destino carrega?
  const hasVideo = target.media.some((m) => m.type === 'VIDEO');
  const hasImage = target.media.some((m) => m.type === 'IMAGE');
  const isCarousel = target.media.length > 1;

  if (isCarousel && def.capabilities.publishCarousel.level === 'UNSUPPORTED') {
    push(target.targetKey, {
      code: 'CAROUSEL_UNSUPPORTED',
      severity: 'ERROR',
      message:
        `Este recurso não está disponível pela API oficial desta plataforma ` +
        `(${def.displayName}: publicação com várias mídias).`,
    });
  }
  if (hasVideo && def.capabilities.publishVideo.level === 'UNSUPPORTED') {
    push(target.targetKey, {
      code: 'VIDEO_UNSUPPORTED',
      severity: 'ERROR',
      message:
        `Este recurso não está disponível pela API oficial desta plataforma ` +
        `(${def.displayName}: publicar vídeo).`,
    });
  }
  if (hasImage && !hasVideo && def.capabilities.publishImage.level === 'UNSUPPORTED') {
    push(target.targetKey, {
      code: 'IMAGE_UNSUPPORTED',
      severity: 'ERROR',
      message:
        `Este recurso não está disponível pela API oficial desta plataforma ` +
        `(${def.displayName}: publicar imagem).`,
    });
  }
  if (target.media.length === 0 && def.capabilities.publishText.level === 'UNSUPPORTED') {
    push(target.targetKey, {
      code: 'TEXT_ONLY_UNSUPPORTED',
      severity: 'ERROR',
      message: `${def.displayName} não aceita publicação apenas com texto.`,
    });
  }

  // Capacidade que existe mas depende de aprovação/tipo de conta.
  const publishCap = hasVideo ? def.capabilities.publishVideo : def.capabilities.publishImage;
  if (publishCap.limitation) {
    push(target.targetKey, {
      code: 'PLATFORM_LIMITATION',
      severity: 'WARNING',
      message: `${def.displayName}: ${publishCap.limitation}`,
    });
  }
}

function validateAccountStatus(target: TargetValidationInput, push: Push): void {
  if (target.accountStatus === 'ACTIVE') return;

  const messages: Record<string, string> = {
    NEEDS_RECONNECT:
      `A conta "${target.accountLabel}" precisa ser reconectada — o token de acesso ` +
      `expirou ou foi revogado.`,
    DISCONNECTED: `A conta "${target.accountLabel}" está desconectada.`,
    SUSPENDED: `A conta "${target.accountLabel}" está suspensa pela plataforma.`,
  };

  push(target.targetKey, {
    code: `ACCOUNT_${target.accountStatus}`,
    severity: 'ERROR',
    message: messages[target.accountStatus] ?? `Conta indisponível: ${target.accountLabel}.`,
  });
}

function validateAiReview(target: TargetValidationInput, push: Push): void {
  if (!target.aiNeedsReview) return;

  push(target.targetKey, {
    code: 'AI_REVIEW_REQUIRED',
    severity: 'ERROR',
    message:
      'Este conteúdo foi gerado por IA e ainda não passou por revisão humana. ' +
      'Revise e registre a revisão antes de agendar.',
    field: 'body',
  });
}

function validateSchedule(
  target: TargetValidationInput,
  ctx: ValidationContext,
  push: Push,
): void {
  if (target.scheduledAt === null) return;

  if (target.scheduledAt.getTime() <= ctx.now.getTime()) {
    push(target.targetKey, {
      code: 'SCHEDULE_IN_PAST',
      severity: 'ERROR',
      message:
        `O horário agendado para "${target.accountLabel}" já passou no fuso da conta ` +
        `(${target.accountTimezone}).`,
      field: 'scheduledAt',
    });
  }
}

function validateTextFields(
  target: TargetValidationInput,
  def: PlatformDefinition,
  push: Push,
): void {
  const req = def.mediaRequirements;

  if (req.titleRequired && !target.title?.trim()) {
    push(target.targetKey, {
      code: 'TITLE_REQUIRED',
      severity: 'ERROR',
      message: `${def.displayName} exige um título para a publicação.`,
      field: 'title',
    });
  }

  if (req.maxTitleLength && target.title && target.title.length > req.maxTitleLength) {
    push(target.targetKey, {
      code: 'TITLE_TOO_LONG',
      severity: 'ERROR',
      message:
        `O título tem ${target.title.length} caracteres e o limite de ` +
        `${def.displayName} é ${req.maxTitleLength}.`,
      field: 'title',
    });
  }

  if (req.maxCaptionLength && target.body.length > req.maxCaptionLength) {
    push(target.targetKey, {
      code: 'CAPTION_TOO_LONG',
      severity: 'ERROR',
      message:
        `A legenda tem ${target.body.length} caracteres e o limite de ` +
        `${def.displayName} é ${req.maxCaptionLength}.`,
      field: 'body',
    });
  }

  if (req.maxHashtags !== undefined && target.hashtags.length > req.maxHashtags) {
    push(target.targetKey, {
      code: 'TOO_MANY_HASHTAGS',
      severity: 'WARNING',
      message:
        `${target.hashtags.length} hashtags para um limite recomendado de ` +
        `${req.maxHashtags} em ${def.displayName}.`,
      field: 'hashtags',
    });
  }

  if (req.mediaRequired && target.media.length === 0) {
    push(target.targetKey, {
      code: 'MEDIA_REQUIRED',
      severity: 'ERROR',
      message: `${def.displayName} exige pelo menos um arquivo de mídia.`,
      field: 'media',
    });
  }
}

function validateMedia(
  target: TargetValidationInput,
  def: PlatformDefinition,
  push: Push,
): void {
  for (const media of target.media) {
    if (media.processingStatus === 'FAILED') {
      push(target.targetKey, {
        code: 'MEDIA_PROCESSING_FAILED',
        severity: 'ERROR',
        message: `O processamento de "${media.filename}" falhou. Reenvie o arquivo.`,
        field: 'media',
      });
      continue;
    }

    if (media.processingStatus !== 'READY') {
      push(target.targetKey, {
        code: 'MEDIA_NOT_READY',
        severity: 'WARNING',
        message:
          `"${media.filename}" ainda está sendo processado. As dimensões e a duração ` +
          `só serão validadas quando o processamento terminar.`,
        field: 'media',
      });
    }

    const spec: MediaSpec | undefined =
      media.type === 'VIDEO' ? def.mediaRequirements.video : def.mediaRequirements.image;

    if (!spec) {
      push(target.targetKey, {
        code: 'MEDIA_TYPE_UNSUPPORTED',
        severity: 'ERROR',
        message:
          `Este recurso não está disponível pela API oficial desta plataforma ` +
          `(${def.displayName}: ${media.type === 'VIDEO' ? 'vídeo' : 'imagem'}).`,
        field: 'media',
      });
      continue;
    }

    if (spec.mimeTypes.length > 0 && !spec.mimeTypes.includes(media.mimeType)) {
      push(target.targetKey, {
        code: 'MEDIA_MIME_UNSUPPORTED',
        severity: 'ERROR',
        message:
          `${def.displayName} não aceita o formato ${media.mimeType} ("${media.filename}"). ` +
          `Formatos aceitos: ${spec.mimeTypes.join(', ')}.`,
        field: 'media',
      });
    }

    if (spec.maxSizeBytes !== undefined && media.sizeBytes > spec.maxSizeBytes) {
      push(target.targetKey, {
        code: 'MEDIA_TOO_LARGE',
        severity: 'ERROR',
        message:
          `"${media.filename}" tem ${formatBytes(media.sizeBytes)} e o limite de ` +
          `${def.displayName} é ${formatBytes(spec.maxSizeBytes)}.`,
        field: 'media',
      });
    }

    if (media.durationMs != null) {
      if (spec.maxDurationMs !== undefined && media.durationMs > spec.maxDurationMs) {
        push(target.targetKey, {
          code: 'MEDIA_TOO_LONG',
          severity: 'ERROR',
          message:
            `"${media.filename}" dura ${formatDuration(media.durationMs)} e o limite de ` +
            `${def.displayName} é ${formatDuration(spec.maxDurationMs)}.`,
          field: 'media',
        });
      }
      if (spec.minDurationMs !== undefined && media.durationMs < spec.minDurationMs) {
        push(target.targetKey, {
          code: 'MEDIA_TOO_SHORT',
          severity: 'ERROR',
          message:
            `"${media.filename}" dura ${formatDuration(media.durationMs)} e o mínimo de ` +
            `${def.displayName} é ${formatDuration(spec.minDurationMs)}.`,
          field: 'media',
        });
      }
    }

    if (media.width != null && media.height != null && media.height > 0) {
      if (spec.minWidth !== undefined && media.width < spec.minWidth) {
        push(target.targetKey, {
          code: 'MEDIA_WIDTH_TOO_SMALL',
          severity: 'ERROR',
          message:
            `"${media.filename}" tem ${media.width}px de largura; ${def.displayName} ` +
            `exige no mínimo ${spec.minWidth}px.`,
          field: 'media',
        });
      }
      if (spec.minHeight !== undefined && media.height < spec.minHeight) {
        push(target.targetKey, {
          code: 'MEDIA_HEIGHT_TOO_SMALL',
          severity: 'ERROR',
          message:
            `"${media.filename}" tem ${media.height}px de altura; ${def.displayName} ` +
            `exige no mínimo ${spec.minHeight}px.`,
          field: 'media',
        });
      }

      if (spec.aspectRatios.length > 0) {
        const actual = media.width / media.height;
        const matches = spec.aspectRatios.some(([w, h]) => {
          if (!w || !h) return false;
          return Math.abs(actual - w / h) <= spec.aspectRatioTolerance;
        });
        if (!matches) {
          const allowed = spec.aspectRatios.map(([w, h]) => `${w}:${h}`).join(', ');
          push(target.targetKey, {
            code: 'MEDIA_ASPECT_RATIO',
            severity: 'ERROR',
            message:
              `"${media.filename}" está em ${media.width}x${media.height} ` +
              `(${actual.toFixed(2)}:1). ${def.displayName} aceita: ${allowed}.`,
            field: 'media',
          });
        }
      }
    }
  }

  const firstSpec =
    target.media.some((m) => m.type === 'VIDEO')
      ? def.mediaRequirements.video
      : def.mediaRequirements.image;

  if (firstSpec && target.media.length > firstSpec.maxItemsPerPost) {
    push(target.targetKey, {
      code: 'TOO_MANY_MEDIA_ITEMS',
      severity: 'ERROR',
      message:
        `${target.media.length} arquivos selecionados; ${def.displayName} aceita no ` +
        `máximo ${firstSpec.maxItemsPerPost} por publicação.`,
      field: 'media',
    });
  }
}

/**
 * Campos que a plataforma EXIGE no fluxo de publicação.
 *
 * A SPEC seção 6.1 é explícita: selecionar um grupo não pode pular isto. Se
 * o grupo tem 5 contas do TikTok, o compositor precisa ter coletado a
 * privacidade e o consentimento das 5 — e é aqui que a falta aparece.
 */
function validateRequiredUxFields(
  target: TargetValidationInput,
  def: PlatformDefinition,
  push: Push,
): void {
  for (const field of def.requiredUxFields.fields) {
    if (!field.required) continue;

    const value = target.platformFields[field.key];

    const missing =
      value === undefined ||
      value === null ||
      (typeof value === 'string' && value.trim() === '');

    if (missing) {
      push(target.targetKey, {
        code: 'REQUIRED_FIELD_MISSING',
        severity: 'ERROR',
        message:
          `${def.displayName} exige o campo "${field.label}" para a conta ` +
          `"${target.accountLabel}".`,
        field: field.key,
      });
      continue;
    }

    if (field.type === 'CONSENT' && value !== true) {
      push(target.targetKey, {
        code: 'CONSENT_REQUIRED',
        severity: 'ERROR',
        message:
          field.consentText ??
          `É necessário aceitar os termos de ${def.displayName} antes de publicar em ` +
            `"${target.accountLabel}".`,
        field: field.key,
      });
    }

    if (field.type === 'BOOLEAN' && typeof value !== 'boolean') {
      push(target.targetKey, {
        code: 'REQUIRED_FIELD_INVALID',
        severity: 'ERROR',
        message: `O campo "${field.label}" precisa ser sim ou não.`,
        field: field.key,
      });
    }

    // Só validamos contra a lista quando ela é fixa. Opções que vêm da API
    // (optionsFromApi) não podem ser conferidas aqui sem inventar valores.
    if (
      field.type === 'SELECT' &&
      !field.optionsFromApi &&
      field.options.length > 0 &&
      !field.options.some((o) => o.value === value)
    ) {
      push(target.targetKey, {
        code: 'REQUIRED_FIELD_INVALID',
        severity: 'ERROR',
        message:
          `Valor inválido para "${field.label}". Opções: ` +
          field.options.map((o) => o.label).join(', ') +
          '.',
        field: field.key,
      });
    }
  }
}

/**
 * Regra de conteúdo igual em várias contas (SPEC seções 3 e 6.1).
 *
 * Onde a plataforma PROÍBE (caso do X), bloqueia. Onde não há proibição
 * explícita mas há risco, avisa. A comparação é por plataforma: publicar o
 * mesmo texto num TikTok e num YouTube não é o caso tratado aqui.
 */
function validateDuplicateContent(
  targets: TargetValidationInput[],
  ctx: ValidationContext,
  push: Push,
): void {
  const byPlatform = new Map<PlatformKey, TargetValidationInput[]>();
  for (const target of targets) {
    const list = byPlatform.get(target.platform) ?? [];
    list.push(target);
    byPlatform.set(target.platform, list);
  }

  for (const [platform, group] of byPlatform) {
    if (group.length < 2) continue;

    const def = ctx.definitions[platform];
    if (!def) continue;

    const policy = def.duplicateContentPolicy;
    if (policy.policy === 'ALLOWED') continue;

    const clusters = groupBySimilarity(
      group,
      (t) => `${t.title ?? ''}\n${t.body}\n${t.hashtags.join(' ')}`,
      policy.similarityThreshold,
    );

    for (const cluster of clusters) {
      const labels = cluster.map((t) => t.accountLabel);

      for (const target of cluster) {
        push(target.targetKey, {
          code:
            policy.policy === 'FORBIDDEN'
              ? 'DUPLICATE_CONTENT_FORBIDDEN'
              : 'DUPLICATE_CONTENT_RISK',
          severity: policy.policy === 'FORBIDDEN' ? 'ERROR' : 'WARNING',
          message:
            `${policy.explanation} Contas com conteúdo igual ou semelhante: ` +
            `${labels.join(', ')}.` +
            (policy.policyUrl ? ` Política: ${policy.policyUrl}` : ''),
          field: 'body',
        });
      }
    }
  }
}

/**
 * Cota do dia, por conta e por app/projeto (SPEC seções 3 e 12).
 *
 * O lote é contado JUNTO: 20 destinos para a mesma plataforma consomem 20 da
 * cota de app, não 1 cada um avaliado isoladamente. Sem isso, um agendamento
 * em grupo passa na validação e estoura a cota na hora de publicar — que é
 * exatamente o que a SPEC manda evitar.
 */
function validateQuota(
  targets: TargetValidationInput[],
  ctx: ValidationContext,
  push: Push,
): void {
  // Consumo acumulado DENTRO deste lote.
  const batchAccount = new Map<string, { count: number; units: number }>();
  const batchApp = new Map<string, { count: number; units: number }>();

  for (const target of targets) {
    const def = ctx.definitions[target.platform];
    if (!def) continue;

    const { rules, verified, sourceUrl } = def.quotaRules;
    if (rules.length === 0) continue;

    for (const rule of rules) {
      const key =
        rule.scope === 'ACCOUNT'
          ? `${target.platform}:${target.accountId}`
          : `${target.platform}`;

      const persisted =
        rule.scope === 'ACCOUNT'
          ? (ctx.quota.accountUsage.get(key) ?? { count: 0, units: 0 })
          : (ctx.quota.appUsage.get(key) ?? { count: 0, units: 0 });

      const batchMap = rule.scope === 'ACCOUNT' ? batchAccount : batchApp;
      const inBatch = batchMap.get(key) ?? { count: 0, units: 0 };

      const used = rule.unit === 'POSTS' ? persisted.count : persisted.units;
      const pending = rule.unit === 'POSTS' ? inBatch.count : inBatch.units;
      const projected = used + pending + rule.costPerPublish;

      if (projected > rule.limit) {
        const scopeText =
          rule.scope === 'APP'
            ? `do aplicativo em ${def.displayName} (limite compartilhado por toda a plataforma)`
            : `da conta "${target.accountLabel}" em ${def.displayName}`;

        push(target.targetKey, {
          // Limite não confirmado na documentação oficial vira aviso, nunca
          // bloqueio — a regra 6 da SPEC proíbe agir sobre número inventado.
          code: verified ? 'QUOTA_EXCEEDED' : 'QUOTA_LIKELY_EXCEEDED',
          severity: verified ? 'ERROR' : 'WARNING',
          message:
            `A cota diária ${scopeText} seria estourada por este agendamento ` +
            `(${projected} de ${rule.limit} ${rule.unit === 'POSTS' ? 'publicações' : 'unidades'}). ` +
            (verified
              ? 'Escolha outro dia ou reduza os destinos.'
              : 'Este limite ainda não foi confirmado na documentação oficial.') +
            (rule.note ? ` ${rule.note}` : '') +
            (sourceUrl ? ` Fonte: ${sourceUrl}` : ''),
          field: 'scheduledAt',
        });
      }

      // Reserva o consumo deste destino para os próximos do lote.
      batchMap.set(key, {
        count: inBatch.count + (rule.unit === 'POSTS' ? rule.costPerPublish : 0),
        units: inBatch.units + (rule.unit === 'UNITS' ? rule.costPerPublish : 0),
      });
    }
  }
}

// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}min`;
  if (minutes > 0) return `${minutes}min${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

