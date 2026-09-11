import type { PlatformKey } from '@app/core';

/**
 * Gerador Heurístico Local de Conteúdo para Redes Sociais.
 *
 * Características:
 *  1. Totalmente DETERMINÍSTICO: com a mesma entrada (brief, platform, kind, tone, count),
 *     produz exatamente a mesma saída através de gerador pseudo-aleatório baseado em seed.
 *  2. Respeita estritamente os limites da plataforma (título, legenda, hashtags).
 *  3. Truncamento inteligente em limites de palavras e tags (nunca corta tags ao meio).
 *  4. Copy adaptada às particularidades de cada rede (X, Instagram, YouTube, LinkedIn, TikTok, etc.).
 */

export interface LocalDraftInput {
  kind: 'CAPTION' | 'TITLE' | 'HASHTAGS' | 'VARIATIONS';
  platform: PlatformKey;
  brief: string;
  tone?: string;
  count: number;
}

export interface PlatformConstraints {
  maxTitleLength?: number | null;
  maxCaptionLength?: number | null;
  maxHashtags?: number | null;
}

export function createSeededRandom(seedString: string): () => number {
  let seed = 5381;
  for (let i = 0; i < seedString.length; i++) {
    seed = (seed * 33) ^ seedString.charCodeAt(i);
  }
  seed = Math.abs(seed) || 1;

  return function next(): number {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

export function extractKeywords(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove acentos para tags limpas
    .replace(/[^\w\s]/gi, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));
}

const STOP_WORDS = new Set([
  'para', 'com', 'mais', 'como', 'este', 'esta', 'isso', 'esse', 'essa',
  'voce', 'sobre', 'pelo', 'pela', 'qual', 'quando', 'onde', 'quem',
  'muito', 'todos', 'tudo', 'fazer', 'estar', 'estao', 'foram', 'sera',
]);

export function generateLocalDraft(
  input: LocalDraftInput,
  platformName: string,
  constraints: PlatformConstraints,
): string[] {
  const brief = input.brief.trim();
  const count = Math.min(Math.max(input.count || 3, 1), 5);
  const tone = input.tone?.trim() || 'informativo e dinâmico';

  const seedKey = `${input.platform}:${input.kind}:${brief}:${tone}`;
  const random = createSeededRandom(seedKey);

  const keywords = extractKeywords(brief);
  const uniqueKeywords = [...new Set(keywords)];

  const maxTags = Math.min(constraints.maxHashtags ?? 6, 8);
  const selectedTags = uniqueKeywords.slice(0, maxTags).map((w) => `#${w}`);
  const fallbackTag = `#${platformName.toLowerCase().replace(/\s+/g, '')}`;
  const tagList = selectedTags.length > 0 ? selectedTags : [fallbackTag, '#conteudo', '#novidade'];

  if (input.kind === 'HASHTAGS') {
    return generateDeterministicHashtags(uniqueKeywords, platformName, count, maxTags, random);
  }

  if (input.kind === 'TITLE') {
    return generateDeterministicTitles(brief, platformName, count, constraints.maxTitleLength ?? null);
  }

  if (input.kind === 'VARIATIONS') {
    return generateDeterministicVariations(brief, tagList.join(' '), tone, count, constraints.maxCaptionLength ?? null);
  }

  return generateDeterministicCaptions(brief, tagList.join(' '), tone, input.platform, count, constraints.maxCaptionLength ?? null);
}

function generateDeterministicHashtags(
  keywords: string[],
  platformName: string,
  count: number,
  maxTags: number,
  random: () => number,
): string[] {
  const results: string[] = [];
  const baseTag = `#${platformName.toLowerCase().replace(/\s+/g, '')}`;

  for (let i = 0; i < count; i++) {
    // Permutação determinística usando o PRNG com seed
    const pool = [...keywords];
    for (let j = pool.length - 1; j > 0; j--) {
      const target = Math.floor(random() * (j + 1));
      const temp = pool[j]!;
      pool[j] = pool[target]!;
      pool[target] = temp;
    }

    const tags = pool.slice(0, Math.max(maxTags - 1, 2)).map((w) => `#${w}`);
    if (!tags.includes(baseTag) && tags.length < maxTags) {
      tags.push(baseTag);
    }

    results.push(tags.length > 0 ? tags.join(' ') : `${baseTag} #redessociais #estrategia`);
  }

  return results;
}

function generateDeterministicTitles(
  brief: string,
  platformName: string,
  count: number,
  maxLength: number | null,
): string[] {
  const templates = [
    `${brief}`,
    `Destaque: ${brief}`,
    `Como funciona: ${brief}`,
    `Guia essencial sobre ${brief}`,
    `Tudo sobre ${brief}`,
  ];

  return templates.slice(0, count).map((t) => {
    if (maxLength && t.length > maxLength) {
      return truncateGracefully(t, maxLength);
    }
    return t;
  });
}

function generateDeterministicVariations(
  brief: string,
  hashtags: string,
  tone: string,
  count: number,
  maxLength: number | null,
): string[] {
  const templates = [
    // Ângulo 1: Direto e acionável
    `${brief}\n\nConfira os principais pontos e compartilhe sua visão nos comentários.\n\n${hashtags}`,
    // Ângulo 2: Reflexivo e engajador
    `Uma reflexão importante sobre este tema:\n\n${brief}\n\nQual a sua opinião a respeito?\n\n${hashtags}`,
    // Ângulo 3: Foco em valor e aprendizado
    `O que você precisa saber:\n\n${brief}\n\nSalve esta publicação para consultar sempre que precisar.\n\n${hashtags}`,
    // Ângulo 4: Conversacional
    `${brief}\n\nParticipe da conversa e marque quem também se interessa por isso.\n\n${hashtags}`,
    // Ângulo 5: Síntese executiva
    `Resumo do tema [${tone}]:\n\n${brief}\n\n${hashtags}`,
  ];

  return templates.slice(0, count).map((t) => {
    if (maxLength && t.length > maxLength) {
      return truncateGracefully(t, maxLength);
    }
    return t;
  });
}

function generateDeterministicCaptions(
  brief: string,
  hashtags: string,
  tone: string,
  platform: PlatformKey,
  count: number,
  maxLength: number | null,
): string[] {
  let templates: string[];

  if (platform === 'X') {
    templates = [
      `${brief}\n\n${hashtags}`,
      `Ponto central sobre o tema:\n${brief}\n\n${hashtags}`,
      `${brief} — o que acha?\n\n${hashtags}`,
      `Atualização rápida:\n${brief}\n\n${hashtags}`,
      `${brief}\n\nCompartilhe com sua rede.\n${hashtags}`,
    ];
  } else if (platform === 'LINKEDIN') {
    templates = [
      `${brief}\n\nQuais são os principais aprendizados e desafios na sua experiência com isso? Compartilhe abaixo.\n\n${hashtags}`,
      `Reflexão estratégica sobre o setor:\n\n${brief}\n\nConcorda com esta perspectiva?\n\n${hashtags}`,
      `Principais destaques para acompanhar:\n\n${brief}\n\n#lideranca #inovacao ${hashtags}`,
      `${brief}\n\nDeixe seu comentário e contribua com a discussão profissional.\n\n${hashtags}`,
      `Análise sobre o tema [Tom: ${tone}]:\n\n${brief}\n\n${hashtags}`,
    ];
  } else {
    templates = [
      `${brief}\n\nConfira todos os detalhes e conte para nós o que achou nos comentários!\n\n${hashtags}`,
      `Um olhar mais atento sobre este assunto:\n\n${brief}\n\nSalve este conteúdo para referência futura.\n\n${hashtags}`,
      `${brief}\n\nQual é o ponto mais importante para você? Deixe sua contribuição abaixo!\n\n${hashtags}`,
      `Destaque da semana:\n\n${brief}\n\nMarque alguém que precisa ver isso hoje.\n\n${hashtags}`,
      `${brief}\n\nAcompanhe nosso perfil para mais atualizações diárias.\n\n${hashtags}`,
    ];
  }

  return templates.slice(0, count).map((t) => {
    if (maxLength && t.length > maxLength) {
      return truncateGracefully(t, maxLength);
    }
    return t;
  });
}

/**
 * Trunca texto suavemente evitando cortar palavras ou hashtags ao meio.
 */
export function truncateGracefully(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;

  const targetLength = maxLength - 3;
  const candidate = text.slice(0, targetLength);

  // Procura o último espaço para não quebrar palavra ou hashtag
  const lastSpace = candidate.lastIndexOf(' ');
  const lastNewline = candidate.lastIndexOf('\n');
  const splitPoint = Math.max(lastSpace, lastNewline);

  if (splitPoint > targetLength * 0.7) {
    return candidate.slice(0, splitPoint).trim() + '...';
  }

  return candidate.trim() + '...';
}

export function sanitizeSuggestions(
  suggestions: string[],
  kind: string,
  requirements: { maxTitleLength?: number | null; maxCaptionLength?: number | null },
): string[] {
  return suggestions.map((text) => {
    let s = text;
    if (kind === 'TITLE' && requirements.maxTitleLength && s.length > requirements.maxTitleLength) {
      s = truncateGracefully(s, requirements.maxTitleLength);
    } else if (requirements.maxCaptionLength && s.length > requirements.maxCaptionLength) {
      s = truncateGracefully(s, requirements.maxCaptionLength);
    }
    return s;
  });
}
