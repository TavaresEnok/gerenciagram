import { describe, expect, it } from 'vitest';
import {
  createSeededRandom,
  extractKeywords,
  generateLocalDraft,
  sanitizeSuggestions,
  truncateGracefully,
} from './local-generator.js';

describe('Local Draft Heuristic Generator', () => {
  it('é estritamente determinístico (mesma entrada = mesma saída)', () => {
    const input = {
      kind: 'CAPTION' as const,
      platform: 'INSTAGRAM' as const,
      brief: 'Lançamento de funcionalidade inovadora de anti-spam para publicações',
      tone: 'profissional',
      count: 3,
    };
    const constraints = { maxCaptionLength: 2200, maxHashtags: 30 };

    const firstRun = generateLocalDraft(input, 'Instagram', constraints);
    const secondRun = generateLocalDraft(input, 'Instagram', constraints);

    expect(firstRun).toEqual(secondRun);
    expect(firstRun).toHaveLength(3);
    expect(firstRun[0]).toContain('Lançamento de funcionalidade');
  });

  it('gera hashtags determinísticas sem ultrapassar o limite da plataforma', () => {
    const input = {
      kind: 'HASHTAGS' as const,
      platform: 'TIKTOK' as const,
      brief: 'Estratégia de marketing digital e produção de vídeos curtos',
      count: 3,
    };
    const constraints = { maxHashtags: 5 };

    const run1 = generateLocalDraft(input, 'TikTok', constraints);
    const run2 = generateLocalDraft(input, 'TikTok', constraints);

    expect(run1).toEqual(run2);
    expect(run1).toHaveLength(3);

    for (const group of run1) {
      const tags = group.split(/\s+/).filter(Boolean);
      expect(tags.length).toBeLessThanOrEqual(5);
      for (const tag of tags) {
        expect(tag.startsWith('#')).toBe(true);
      }
    }
  });

  it('respeita os limites de tamanho de título da plataforma', () => {
    const input = {
      kind: 'TITLE' as const,
      platform: 'YOUTUBE' as const,
      brief: 'Um guia absolutamente completo e detalhado com todas as melhores práticas para crescer nas redes sociais em 2026',
      count: 3,
    };
    const constraints = { maxTitleLength: 60 };

    const titles = generateLocalDraft(input, 'YouTube', constraints);
    expect(titles).toHaveLength(3);

    for (const title of titles) {
      expect(title.length).toBeLessThanOrEqual(60);
    }
  });

  it('respeita os limites de tamanho de legenda no X (Twitter)', () => {
    const input = {
      kind: 'CAPTION' as const,
      platform: 'X' as const,
      brief: 'Notícia de última hora sobre a evolução das ferramentas de inteligência artificial em ambientes corporativos e fluxos de trabalho distribuídos',
      count: 3,
    };
    const constraints = { maxCaptionLength: 280, maxHashtags: 4 };

    const tweets = generateLocalDraft(input, 'X', constraints);
    expect(tweets).toHaveLength(3);

    for (const tweet of tweets) {
      expect(tweet.length).toBeLessThanOrEqual(280);
    }
  });

  it('gera legendas adaptadas para plataformas de vídeo (TikTok, YouTube, Kwai)', () => {
    const input = {
      kind: 'CAPTION' as const,
      platform: 'TIKTOK' as const,
      brief: 'Bastidores de uma gravação em estúdio',
      count: 2,
    };
    const captions = generateLocalDraft(input, 'TikTok', { maxCaptionLength: 1000 });
    expect(captions).toHaveLength(2);
    expect(captions[0]).toContain('Bastidores de uma gravação em estúdio');
    expect(captions[0]).toMatch(/comentários|curta|siga/i);
  });

  it('extrai palavras-chave ignorando acentos e stop words', () => {
    const keywords = extractKeywords('Esta é uma publicação sobre inovação e estratégias para você!');
    expect(keywords).not.toContain('esta');
    expect(keywords).not.toContain('para');
    expect(keywords).not.toContain('voce');
    expect(keywords).toContain('publicacao');
    expect(keywords).toContain('inovacao');
    expect(keywords).toContain('estrategias');
  });

  describe('truncateGracefully', () => {
    it('não altera texto que já cabe no limite', () => {
      const text = 'Texto curto dentro do limite.';
      expect(truncateGracefully(text, 50)).toBe(text);
    });

    it('trunca em limite de palavra sem quebrar hashtag ou palavra no meio', () => {
      const text = 'Primeira parte da mensagem #marketingdigital #redessociais';
      const truncated = truncateGracefully(text, 35);

      expect(truncated.endsWith('...')).toBe(true);
      expect(truncated.length).toBeLessThanOrEqual(35);
      // Não deve cortar #marketingdigital pela metade como "#market..."
      expect(truncated).not.toMatch(/#marke\w*\.\.\.$/);
    });
  });

  describe('sanitizeSuggestions', () => {
    it('aplica o truncamento respeitando as restrições', () => {
      const longCaptions = [
        'Texto muito longo '.repeat(10) + '#tag1 #tag2',
      ];
      const sanitized = sanitizeSuggestions(longCaptions, 'CAPTION', { maxCaptionLength: 40 });
      expect(sanitized[0]!.length).toBeLessThanOrEqual(40);
      expect(sanitized[0]!.endsWith('...')).toBe(true);
    });
  });
});
