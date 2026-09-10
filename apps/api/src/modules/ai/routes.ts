import {
  PLATFORM_KEYS,
  PlatformApiError,
  ValidationError,
  getPlatformDefinition,
  withTimeout,
  type PlatformKey,
} from '@app/core';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { recordAudit } from '../../lib/audit.js';
import { requireAuth } from '../../plugins/auth.js';
import type { AppInstance } from '../../types.js';

/**
 * Módulo de IA (SPEC seção 6, Fase 13).
 *
 * Duas regras que a especificação impõe e que estão no código, não só na UI:
 *
 *  1. REVISÃO HUMANA OBRIGATÓRIA. O que sai daqui é sugestão: o conteúdo
 *     nasce com `aiGenerated = true` e `aiReviewedAt = null`, e o worker se
 *     recusa a publicar nesse estado. Aprovar é ato de uma pessoa.
 *  2. SEM CHAVE, SEM MÓDULO. Faltando ANTHROPIC_API_KEY, os endpoints
 *     respondem que o módulo não está configurado — nunca devolvem texto
 *     falso para "parecer que funciona".
 *
 * A geração respeita os limites reais da rede (título, legenda, hashtags),
 * lidos de `SocialPlatform` — sugerir 300 caracteres para um título de 100
 * gastaria a revisão da pessoa com um texto que nem pode ser usado.
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
  error?: { type: string; message: string };
}

export async function registerAiRoutes(
  app: AppInstance,
  container: Container,
): Promise<void> {
  const isConfigured = (): boolean => Boolean(container.env.ANTHROPIC_API_KEY?.trim());

  app.get(
    '/ai/status',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['IA'],
        summary: 'Se o módulo de IA está disponível neste ambiente',
        response: {
          200: z.object({
            configured: z.boolean(),
            model: z.string().nullable(),
            reason: z.string().nullable(),
          }),
        },
      },
    },
    async () => ({
      configured: isConfigured(),
      model: isConfigured() ? container.env.AI_MODEL : null,
      reason: isConfigured()
        ? null
        : 'O módulo de IA não está configurado neste ambiente (falta ANTHROPIC_API_KEY).',
    }),
  );

  app.post(
    '/ai/suggest',
    {
      preHandler: app.requirePermission('ai:generate'),
      config: { rateLimit: { max: 60, timeWindow: 3_600_000 } },
      schema: {
        tags: ['IA'],
        summary: 'Sugere legendas, títulos ou hashtags para uma rede',
        description:
          'Devolve SUGESTÕES. Todo conteúdo criado a partir daqui exige revisão humana ' +
          'antes de publicar — o worker bloqueia a publicação de conteúdo de IA não revisado.',
        body: z.object({
          kind: z.enum(['CAPTION', 'TITLE', 'HASHTAGS', 'VARIATIONS']),
          platform: z.enum(PLATFORM_KEYS),
          /** Assunto ou rascunho de partida. */
          brief: z.string().min(3).max(4000),
          tone: z.string().max(120).optional(),
          language: z.string().max(20).default('pt-BR'),
          count: z.number().int().min(1).max(5).default(3),
        }),
        response: {
          200: z.object({
            suggestions: z.array(z.string()),
            /** Sempre true: nenhuma sugestão pode ir ao ar sem revisão. */
            requiresHumanReview: z.literal(true),
            constraints: z.object({
              maxTitleLength: z.number().nullable(),
              maxCaptionLength: z.number().nullable(),
              maxHashtags: z.number().nullable(),
            }),
          }),
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);

      if (!isConfigured()) {
        throw new ValidationError(
          'O módulo de IA não está configurado neste ambiente. ' +
            'Preencha ANTHROPIC_API_KEY no .env para ativá-lo.',
        );
      }

      const definition = getPlatformDefinition(request.body.platform);
      const requirements = definition.mediaRequirements;

      const suggestions = await callAnthropic(
        container,
        buildPrompt(request.body, definition.displayName, requirements),
        request.correlationId,
      );

      await recordAudit(container.prisma, {
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        action: 'ai.suggest',
        entityType: 'Content',
        changes: {
          tipo: request.body.kind,
          plataforma: request.body.platform,
          sugestoes: suggestions.length,
        },
        correlationId: request.correlationId,
      });

      return {
        suggestions,
        requiresHumanReview: true as const,
        constraints: {
          maxTitleLength: requirements.maxTitleLength ?? null,
          maxCaptionLength: requirements.maxCaptionLength ?? null,
          maxHashtags: requirements.maxHashtags ?? null,
        },
      };
    },
  );

  app.post(
    '/contents/:contentId/ai-review',
    {
      preHandler: app.requirePermission('content:update'),
      schema: {
        tags: ['IA'],
        summary: 'Registra a revisão humana de um conteúdo gerado por IA',
        description:
          'Sem esta confirmação, o worker se recusa a publicar o conteúdo. É o ' +
          'controle exigido pela SPEC seção 6.',
        params: z.object({ contentId: z.string().uuid() }),
        response: { 200: z.object({ reviewedAt: z.string(), reviewedBy: z.string() }) },
      },
    },
    async (request) => {
      const auth = requireAuth(request);

      const content = await container.prisma.content.findFirst({
        where: {
          id: request.params.contentId,
          organizationId: auth.organizationId,
          deletedAt: null,
        },
        select: { id: true, aiGenerated: true },
      });

      if (!content) throw new ValidationError('Conteúdo não encontrado.');
      if (!content.aiGenerated) {
        throw new ValidationError(
          'Este conteúdo não foi gerado por IA — não há revisão de IA a registrar.',
        );
      }

      const reviewedAt = new Date();

      await container.prisma.content.update({
        where: { id: content.id },
        data: { aiReviewedAt: reviewedAt },
      });

      await recordAudit(container.prisma, {
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        action: 'ai.human_review',
        entityType: 'Content',
        entityId: content.id,
        correlationId: request.correlationId,
      });

      return { reviewedAt: reviewedAt.toISOString(), reviewedBy: auth.userId };
    },
  );
}

// ---------------------------------------------------------------------------

function buildPrompt(
  input: { kind: string; brief: string; tone?: string | undefined; language: string; count: number },
  platformName: string,
  requirements: { maxTitleLength?: number | undefined; maxCaptionLength?: number | undefined; maxHashtags?: number | undefined },
): string {
  const limits: string[] = [];
  if (requirements.maxTitleLength) {
    limits.push(`título: no máximo ${requirements.maxTitleLength} caracteres`);
  }
  if (requirements.maxCaptionLength) {
    limits.push(`legenda: no máximo ${requirements.maxCaptionLength} caracteres`);
  }
  if (requirements.maxHashtags) {
    limits.push(`hashtags: no máximo ${requirements.maxHashtags}`);
  }

  const kindInstruction: Record<string, string> = {
    CAPTION: 'Escreva legendas para a publicação.',
    TITLE: 'Escreva títulos para a publicação.',
    HASHTAGS: 'Sugira conjuntos de hashtags, separadas por espaço, cada conjunto numa linha.',
    VARIATIONS: 'Escreva variações do texto abaixo, mantendo a mensagem central.',
  };

  return [
    `Você escreve para redes sociais em ${input.language}.`,
    `Rede de destino: ${platformName}.`,
    limits.length > 0 ? `Limites da plataforma — ${limits.join('; ')}.` : '',
    input.tone ? `Tom desejado: ${input.tone}.` : '',
    '',
    kindInstruction[input.kind] ?? kindInstruction['CAPTION'],
    `Gere exatamente ${input.count} opções.`,
    'Responda APENAS com as opções, uma por linha, sem numeração, sem aspas e sem comentários.',
    '',
    'Assunto:',
    input.brief,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

async function callAnthropic(
  container: Container,
  prompt: string,
  correlationId: string,
): Promise<string[]> {
  // Timeout explícito, como em qualquer chamada externa (SPEC seção 12).
  const { signal, cancel } = withTimeout(60_000);

  try {
    const response = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': container.env.ANTHROPIC_API_KEY as string,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: container.env.AI_MODEL,
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal,
    });

    const text = await response.text();

    if (!response.ok) {
      container.logger.error(
        { status: response.status, correlationId },
        'falha ao chamar a API de IA',
      );
      throw new PlatformApiError(
        `O serviço de IA respondeu com erro (${response.status}).`,
        { retryable: response.status >= 500, platform: 'IA', httpStatus: response.status },
      );
    }

    const payload = JSON.parse(text) as AnthropicResponse;
    const content = payload.content?.find((block) => block.type === 'text')?.text ?? '';

    return content
      .split('\n')
      .map((line) => line.trim())
      // Remove numeração e marcadores que o modelo às vezes insere apesar da
      // instrução, para o texto entrar limpo no compositor.
      .map((line) => line.replace(/^[-*•]\s*/, '').replace(/^\d+[.)]\s*/, ''))
      .filter((line) => line.length > 0);
  } catch (error) {
    if (error instanceof PlatformApiError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new PlatformApiError('O serviço de IA demorou demais para responder.', {
        retryable: true,
        platform: 'IA',
      });
    }
    throw new PlatformApiError(
      `Não foi possível falar com o serviço de IA: ${error instanceof Error ? error.message : String(error)}`,
      { retryable: true, platform: 'IA', cause: error },
    );
  } finally {
    cancel();
  }
}

export type { PlatformKey };
