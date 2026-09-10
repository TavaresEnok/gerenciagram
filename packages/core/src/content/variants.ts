import type { PlatformKey } from '../platform/capabilities.js';

/**
 * Cascata de resolução do texto de um destino.
 *
 *   override da CONTA  >  variação da PLATAFORMA  >  conteúdo MESTRE
 *
 * Fica no núcleo, e não em cada aplicação, porque a API usa esta função para
 * montar o preview e o worker usa para montar o que vai ser publicado. Se as
 * duas implementações divergissem, o publicado não seria o que a pessoa
 * revisou na tela — que é exatamente o tipo de bug que ninguém percebe até
 * um cliente reclamar.
 */

export interface MasterContent {
  title: string | null;
  body: string;
  hashtags: string[];
}

export interface VariantRecord {
  platform: PlatformKey;
  /** Nulo = variação da plataforma. Preenchido = override daquela conta. */
  socialAccountId: string | null;
  title: string | null;
  body: string | null;
  hashtags: string[];
  platformFields: unknown;
}

export interface ResolvedVariant {
  title: string | null;
  body: string;
  hashtags: string[];
  platformFields: Record<string, unknown>;
}

export function resolveVariantFor(
  master: MasterContent,
  variants: VariantRecord[],
  platform: PlatformKey,
  socialAccountId: string,
): ResolvedVariant {
  const platformVariant = variants.find(
    (variant) => variant.platform === platform && variant.socialAccountId === null,
  );
  const accountVariant = variants.find(
    (variant) => variant.platform === platform && variant.socialAccountId === socialAccountId,
  );

  const firstDefined = <T>(...values: Array<T | null | undefined>): T | null => {
    for (const value of values) {
      if (value !== null && value !== undefined) return value;
    }
    return null;
  };

  return {
    title: firstDefined(accountVariant?.title, platformVariant?.title, master.title),
    body: firstDefined(accountVariant?.body, platformVariant?.body, master.body) ?? '',
    // Lista vazia conta como "não definida": salvar uma variação sem hashtags
    // não deve apagar as do conteúdo mestre sem querer.
    hashtags:
      (accountVariant?.hashtags.length ? accountVariant.hashtags : undefined) ??
      (platformVariant?.hashtags.length ? platformVariant.hashtags : undefined) ??
      master.hashtags,
    // Campos de plataforma se COMBINAM em vez de substituir: a variação define
    // o padrão da rede e a conta sobrescreve só o que precisa mudar (ex.: só a
    // privacidade do TikTok 3, mantendo o resto).
    platformFields: {
      ...((platformVariant?.platformFields as Record<string, unknown> | null) ?? {}),
      ...((accountVariant?.platformFields as Record<string, unknown> | null) ?? {}),
    },
  };
}
