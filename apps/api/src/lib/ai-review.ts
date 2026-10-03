import { createHash } from 'node:crypto';
import { ValidationError } from '@app/core';
import type { PrismaClient } from '@app/db';

/**
 * Identidade da VERSÃO revisada de um conteúdo de IA.
 *
 * A revisão humana da SPEC seção 6 não vale "para sempre": vale para o texto
 * que a pessoa realmente leu. Este hash cobre tudo que vai para a rede —
 * título, corpo, hashtags, variações por rede/conta e os campos de plataforma
 * (privacidade, consentimentos). Qualquer mudança nesse conjunto depois da
 * aprovação exige NOVA revisão, e a implementação garante isso invalidando
 * `aiReviewedAt` quando o hash muda.
 */

export interface HashableVariant {
  platform: string;
  socialAccountId: string | null;
  title: string | null;
  body: string | null;
  hashtags: string[];
  platformFields: Record<string, unknown>;
}

export function aiContentHash(
  content: { title: string | null; body: string; hashtags: string[] },
  variants: HashableVariant[],
): string {
  // Ordenação estável: a MESMA revisão não pode depender da ordem em que as
  // variações foram gravadas.
  const normalized = {
    title: content.title ?? '',
    body: content.body,
    hashtags: [...content.hashtags].sort(),
    variants: [...variants]
      .map((variant) => ({
        platform: variant.platform,
        socialAccountId: variant.socialAccountId ?? '',
        title: variant.title ?? '',
        body: variant.body ?? '',
        hashtags: [...variant.hashtags].sort(),
        platformFields: stable(variant.platformFields),
      }))
      .sort((a, b) =>
        `${a.platform}|${a.socialAccountId}`.localeCompare(`${b.platform}|${b.socialAccountId}`),
      ),
  };

  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/**
 * Registra a revisão humana de um conteúdo de IA, VINCULADA à versão atual
 * (texto + hashtags + variações + campos de plataforma). Ação explícita:
 * nunca é disparada por PATCH, autosave ou edição via API.
 */
export async function registerHumanReview(
  prisma: PrismaClient,
  input: { contentId: string; organizationId: string },
): Promise<{ reviewedAt: Date }> {
  const content = await prisma.content.findFirst({
    where: { id: input.contentId, organizationId: input.organizationId, deletedAt: null },
    select: {
      id: true,
      aiGenerated: true,
      title: true,
      body: true,
      hashtags: true,
      variants: {
        select: {
          platform: true,
          socialAccountId: true,
          title: true,
          body: true,
          hashtags: true,
          platformFields: true,
        },
      },
    },
  });

  if (!content) throw new ValidationError('Conteúdo não encontrado.');
  if (!content.aiGenerated) {
    throw new ValidationError(
      'Este conteúdo não foi gerado por IA — não há revisão de IA a registrar.',
    );
  }

  const reviewedAt = new Date();

  await prisma.content.update({
    where: { id: content.id },
    data: {
      aiReviewedAt: reviewedAt,
      aiReviewHash: aiContentHash(
        { title: content.title, body: content.body, hashtags: content.hashtags },
        content.variants.map((variant) => ({
          platform: variant.platform,
          socialAccountId: variant.socialAccountId,
          title: variant.title,
          body: variant.body,
          hashtags: variant.hashtags,
          platformFields: (variant.platformFields as Record<string, unknown> | null) ?? {},
        })),
      ),
    },
  });

  return { reviewedAt };
}

/** Serialização com chaves ordenadas, para objetos de plataforma. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, stable(entry)]),
    );
  }
  return value;
}

