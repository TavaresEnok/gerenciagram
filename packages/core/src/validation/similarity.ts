/**
 * Similaridade de texto, usada para detectar conteúdo "substancialmente
 * semelhante" entre destinos (SPEC seção 6.1).
 *
 * Coeficiente de Dice sobre trigramas de caracteres. Escolhido porque a regra
 * a ser aplicada é sobre conteúdo *quase* igual: trocar um emoji, mudar uma
 * hashtag ou reordenar duas palavras não deve escapar da checagem, e uma
 * comparação por igualdade exata escaparia.
 */

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    // remove acentos (combining diacritical marks)
    .replace(/[̀-ͯ]/g, '')
    // colapsa tudo que não é letra/número em espaço
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function trigrams(text: string): Map<string, number> {
  const padded = `  ${text}  `;
  const counts = new Map<string, number>();
  for (let i = 0; i < padded.length - 2; i += 1) {
    const gram = padded.slice(i, i + 3);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

/** 0 = nada em comum, 1 = idêntico após normalização. */
export function textSimilarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);

  if (na.length === 0 && nb.length === 0) return 1;
  if (na.length === 0 || nb.length === 0) return 0;
  if (na === nb) return 1;

  const ta = trigrams(na);
  const tb = trigrams(nb);

  let intersection = 0;
  let totalA = 0;
  let totalB = 0;

  for (const count of ta.values()) totalA += count;
  for (const count of tb.values()) totalB += count;

  for (const [gram, countA] of ta) {
    const countB = tb.get(gram);
    if (countB !== undefined) intersection += Math.min(countA, countB);
  }

  return (2 * intersection) / (totalA + totalB);
}

/**
 * Agrupa destinos cujo texto é igual ou semelhante acima do limiar.
 * Devolve só os grupos com mais de um membro — os que interessam à regra.
 */
export function groupBySimilarity<T>(
  items: T[],
  getText: (item: T) => string,
  threshold: number,
): T[][] {
  const groups: T[][] = [];
  const assigned = new Set<number>();

  for (let i = 0; i < items.length; i += 1) {
    if (assigned.has(i)) continue;
    const current = items[i];
    if (current === undefined) continue;

    const group: T[] = [current];
    assigned.add(i);

    for (let j = i + 1; j < items.length; j += 1) {
      if (assigned.has(j)) continue;
      const other = items[j];
      if (other === undefined) continue;

      if (textSimilarity(getText(current), getText(other)) >= threshold) {
        group.push(other);
        assigned.add(j);
      }
    }

    if (group.length > 1) groups.push(group);
  }

  return groups;
}
