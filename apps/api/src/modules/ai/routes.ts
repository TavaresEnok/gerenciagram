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
 * Módulo de IA Universal Híbrido (SPEC seção 6, Fase 13 + Melhoria).
 *
 * Suporta:
 *  1. Clientes compatíveis com a API OpenAI (Google Gemini, OpenRouter, Ollama, OpenAI, Groq).
 *  2. Anthropic Claude (via ANTHROPIC_API_KEY).
 *  3. Gerador Local Heurístico de Alta Precisão (Zero-Cost Local Draft):
 *     Quando nenhuma chave remota estiver configurada ou se houver falha de rede/timeout,
 *     gera rascunhos estruturados e contextuais respeitando as restrições da rede,
 *     permitindo operação imediata sem custo ou dependência externa.
 *
 * Regra inegociável da SPEC:
 *  - REVISÃO HUMANA OBRIGATÓRIA: Todo conteúdo gerado/sugerido nasce com
 *    requiresHumanReview = true. O worker se recusa a publicar sem aiReviewedAt.
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
  error?: { type: string; message: string };
}

interface OpenAiChatResponse {
  choices?: Array<{
    message?: { role: string; content?: string };
    finish_reason?: string;
  }>;
  error?: { message: string; type?: string; code?: string };
}

type AiProvider = 'openai-compatible' | 'anthropic' | 'local-draft';

function detectProvider(container: Container): AiProvider {
  if (container.env.AI_BASE_URL || container.env.AI_API_KEY) {
    return 'openai-compatible';
  }
  if (container.env.ANTHROPIC_API_KEY?.trim()) {
    return 'anthropic';
  }
  return 'local-draft';
}

export async function registerAiRoutes(
  app: AppInstance,
  container: Container,
): Promise<void> {
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
            provider: z.string(),
            model: z.string().nullable(),
            reason: z.string().nullable(),
          }),
        },
      },
    },
    async () => {
      const provider = detectProvider(container);
      const isRemote = provider !== 'local-draft';

      return {
        configured: true,
        provider,
        model: isRemote ? container.env.AI_MODEL : 'local-heuristic-v1',
        reason: isRemote
          ? null
          : 'Operando com gerador local heurístico (zero custo). Para usar modelos remotos, defina AI_API_KEY ou ANTHROPIC_API_KEY no .env.',
      };
    },
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
          brief: z.string().min(3).max(4000),
          tone: z.string().max(120).optional(),
          language: z.string().max(20).default('pt-BR'),
          count: z.number().int().min(1).max(5).default(3),
        }),
        response: {
          200: z.object({
            suggestions: z.array(z.string()),
            requiresHumanReview: z.literal(true),
            provider: z.string(),
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
      const definition = getPlatformDefinition(request.body.platform);
      const requirements = definition.mediaRequirements;
      const provider = detectProvider(container);

      let suggestions: string[] = [];
      let usedProvider: string = provider;

      const prompt = buildPrompt(request.body, definition.displayName, requirements);

      if (provider === 'openai-compatible') {
        try {
          suggestions = await callOpenAiCompatible(container, prompt, request.correlationId);
        } catch (error) {
          container.logger.warn(
            { err: error, correlationId: request.correlationId },
            'Falha no provedor OpenAI-compatível, acionando fallback local',
          );
          suggestions = generateLocalDraft(request.body, definition.displayName, requirements);
          usedProvider = 'local-draft (fallback)';
        }
      } else if (provider === 'anthropic') {
        try {
          suggestions = await callAnthropic(container, prompt, request.correlationId);
        } catch (error) {
          container.logger.warn(
            { err: error, correlationId: request.correlationId },
            'Falha no provedor Anthropic, acionando fallback local',
          );
          suggestions = generateLocalDraft(request.body, definition.displayName, requirements);
          usedProvider = 'local-draft (fallback)';
        }
      } else {
        suggestions = generateLocalDraft(request.body, definition.displayName, requirements);
      }

      // Garante limites da plataforma mesmo na saída da IA
      suggestions = sanitizeSuggestions(suggestions, request.body.kind, requirements);

      await recordAudit(container.prisma, {
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        action: 'ai.suggest',
        entityType: 'Content',
        changes: {
          tipo: request.body.kind,
          plataforma: request.body.platform,
          provedor: usedProvider,
          sugestoes: suggestions.length,
        },
        correlationId: request.correlationId,
      });

      return {
        suggestions,
        requiresHumanReview: true as const,
        provider: usedProvider,
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
// Prompt & Calling Logic
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
    CAPTION: 'Escreva legendas para a publicação com gancho, corpo e chamada para ação.',
    TITLE: 'Escreva títulos atraentes para a publicação.',
    HASHTAGS: 'Sugira conjuntos de hashtags relevantes, separadas por espaço, cada conjunto numa linha.',
    VARIATIONS: 'Escreva variações completas do texto abaixo, adaptadas ao formato da rede.',
  };

  return [
    `Você escreve para redes sociais em ${input.language}.`,
    `Rede de destino: ${platformName}.`,
    limits.length > 0 ? `Limites da plataforma — ${limits.join('; ')}.` : '',
    input.tone ? `Tom desejado: ${input.tone}.` : '',
    '',
    kindInstruction[input.kind] ?? kindInstruction['CAPTION'],
    `Gere exatamente ${input.count} opções diferentes.`,
    'Responda APENAS com as opções, uma por linha, sem numeração, sem marcadores e sem comentários.',
    '',
    'Assunto / Briefing:',
    input.brief,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

async function callOpenAiCompatible(
  container: Container,
  prompt: string,
  correlationId: string,
): Promise<string[]> {
  const { signal, cancel } = withTimeout(45_000);

  const rawBase = container.env.AI_BASE_URL?.trim() || 'https://api.openai.com/v1';
  const baseUrl = rawBase.replace(/\/+$/, '');
  const url = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
  const apiKey = container.env.AI_API_KEY?.trim() || container.env.ANTHROPIC_API_KEY?.trim() || '';

  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };

  if (apiKey) {
    headers['authorization'] = `Bearer ${apiKey}`;
    if (url.includes('googleapis.com')) {
      headers['x-goog-api-key'] = apiKey;
    }
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: container.env.AI_MODEL || 'gemini-2.0-flash',
        messages: [
          {
            role: 'system',
            content:
              'Você é um especialista em redação para redes sociais. Devolva apenas o texto solicitado, uma opção por linha, sem numeração ou marcadores.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.7,
      }),
      signal,
    });

    const text = await response.text();

    if (!response.ok) {
      container.logger.error(
        { status: response.status, body: text.slice(0, 500), correlationId },
        'falha ao chamar a API OpenAI-compatível',
      );
      throw new PlatformApiError(
        `O serviço de IA respondeu com erro (${response.status}).`,
        { retryable: response.status >= 500, platform: 'IA', httpStatus: response.status },
      );
    }

    const payload = JSON.parse(text) as OpenAiChatResponse;
    const content = payload.choices?.[0]?.message?.content ?? '';

    return parseLines(content);
  } catch (error) {
    if (error instanceof PlatformApiError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new PlatformApiError('O serviço de IA demorou demais para responder.', {
        retryable: true,
        platform: 'IA',
      });
    }
    throw new PlatformApiError(
      `Não foi possível comunicar com o serviço de IA: ${error instanceof Error ? error.message : String(error)}`,
      { retryable: true, platform: 'IA', cause: error },
    );
  } finally {
    cancel();
  }
}

async function callAnthropic(
  container: Container,
  prompt: string,
  correlationId: string,
): Promise<string[]> {
  const { signal, cancel } = withTimeout(45_000);

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
        'falha ao chamar a API Anthropic',
      );
      throw new PlatformApiError(
        `O serviço de IA respondeu com erro (${response.status}).`,
        { retryable: response.status >= 500, platform: 'IA', httpStatus: response.status },
      );
    }

    const payload = JSON.parse(text) as AnthropicResponse;
    const content = payload.content?.find((block) => block.type === 'text')?.text ?? '';

    return parseLines(content);
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

function parseLines(rawContent: string): string[] {
  return rawContent
    .split('\n')
    .map((line) => line.trim())
    .map((line) => line.replace(/^[-*•]\s*/, '').replace(/^\d+[.)]\s*/, '').replace(/^"|"$/g, ''))
    .filter((line) => line.length > 0);
}

// ---------------------------------------------------------------------------
// Local Draft Heuristic Generator (Zero-Cost Fallback)
// ---------------------------------------------------------------------------

function generateLocalDraft(
  input: { kind: string; brief: string; tone?: string; count: number },
  platformName: string,
  requirements: { maxTitleLength?: number; maxCaptionLength?: number; maxHashtags?: number },
): string[] {
  const brief = input.brief.trim();
  const toneSuffix = input.tone ? ` [Tom: ${input.tone}]` : '';
  const count = Math.min(Math.max(input.count, 1), 5);

  // Extrai palavras-chave do brief para hashtags e títulos
  const words = brief
    .replace(/[^\w\s\u00C0-\u00FF]/gi, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .map((w) => w.toLowerCase());
  const uniqueWords = [...new Set(words)];

  const tags = uniqueWords
    .slice(0, Math.min(requirements.maxHashtags ?? 6, 8))
    .map((w) => `#${w}`)
    .join(' ');

  const defaultHashtags = tags || `#${platformName.toLowerCase().replace(/\s+/g, '')} #novidade #destaque`;

  if (input.kind === 'HASHTAGS') {
    const list: string[] = [];
    for (let i = 0; i < count; i++) {
      const shuffled = [...uniqueWords].sort(() => 0.5 - Math.random());
      const selected = shuffled.slice(0, Math.min(requirements.maxHashtags ?? 5, 6)).map((w) => `#${w}`);
      list.push(selected.length > 0 ? selected.join(' ') : `#${platformName.toLowerCase()} #tendencia #viral`);
    }
    return list;
  }

  if (input.kind === 'TITLE') {
    const titles = [
      `${brief}${toneSuffix}`,
      `O que você precisa saber sobre: ${brief}`,
      `Confira: ${brief} em detalhes`,
      `Descubra como funciona: ${brief}`,
      `Guia rápido: ${brief}`,
    ];
    return titles.slice(0, count);
  }

  if (input.kind === 'VARIATIONS') {
    const variations = [
      `🚀 ${brief}\n\nFique por dentro das novidades e compartilhe sua opinião! 👇\n\n${defaultHashtags}`,
      `Você já conferiu isso? 👀\n\n${brief}\n\nDeixe seu comentário! 👇\n\n${defaultHashtags}`,
      `Destaque do dia: ${brief}\n\nO que achou dessa abordagem? Salve para conferir depois. ✨\n\n${defaultHashtags}`,
      `Importante: ${brief}\n\nAcompanhe nosso perfil para mais atualizações diárias! 🎯\n\n${defaultHashtags}`,
      `Passo a passo sobre ${brief}.\n\nMarque quem precisa ver isso hoje! 🔥\n\n${defaultHashtags}`,
    ];
    return variations.slice(0, count);
  }

  // Padrão: CAPTION
  const captions = [
    `✨ ${brief}\n\nConfira todos os detalhes e deixe sua opinião nos comentários! 👇\n\n${defaultHashtags}`,
    `Você sabia disso? 👀\n\n${brief}\n\nSalve este post para não esquecer! 📌\n\n${defaultHashtags}`,
    `Destaque especial: ${brief}\n\nCompartilhe com quem também vai curtir! 🚀\n\n${defaultHashtags}`,
    `Transforme sua rotina com esta novidade: ${brief}.\n\nConta para a gente o que você achou! 💬\n\n${defaultHashtags}`,
    `Novidade na área! 🔥\n\n${brief}\n\nAcompanhe para conferir mais conteúdos como este. 🎯\n\n${defaultHashtags}`,
  ];

  return captions.slice(0, count);
}

function sanitizeSuggestions(
  suggestions: string[],
  kind: string,
  requirements: { maxTitleLength?: number; maxCaptionLength?: number },
): string[] {
  return suggestions.map((text) => {
    let s = text;
    if (kind === 'TITLE' && requirements.maxTitleLength && s.length > requirements.maxTitleLength) {
      s = s.slice(0, requirements.maxTitleLength - 3).trim() + '...';
    } else if (requirements.maxCaptionLength && s.length > requirements.maxCaptionLength) {
      s = s.slice(0, requirements.maxCaptionLength - 3).trim() + '...';
    }
    return s;
  });
}

export type { PlatformKey };
