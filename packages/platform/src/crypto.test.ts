import { describe, expect, it } from 'vitest';
import { buildKeyring, decrypt, encrypt, parsePreviousKeys } from './crypto.js';

/**
 * Criptografia dos tokens em repouso, com foco na ROTAÇÃO DE CHAVE.
 *
 * A rotação é o caso que ninguém exercita até o dia em que precisa — e o dia
 * em que precisa é justamente o pior para descobrir que não funciona. Estava
 * quebrada: a versão da chave atual era uma constante fixa em 1, então a
 * chave nova ocupava o slot da antiga, todo texto cifrado marcado `v1`
 * passava a falhar na verificação da tag GCM, e todos os tokens OAuth viravam
 * lixo indecifrável.
 *
 * O teste que faltava é o terceiro daqui: cifrar com a chave antiga,
 * rotacionar, e conferir que ainda decifra.
 */

const CHAVE_1 = Buffer.alloc(32, 1).toString('base64');
const CHAVE_2 = Buffer.alloc(32, 2).toString('base64');
const CHAVE_3 = Buffer.alloc(32, 3).toString('base64');

describe('ida e volta', () => {
  it('decifra o que cifrou', () => {
    const chaveiro = buildKeyring(CHAVE_1);
    const cifrado = encrypt('token-secreto-do-youtube', chaveiro);

    expect(cifrado.ciphertext).not.toContain('token-secreto');
    expect(decrypt(cifrado.ciphertext, chaveiro)).toBe('token-secreto-do-youtube');
  });

  it('adulterar o texto cifrado falha em vez de devolver lixo', () => {
    // É a diferença entre GCM e um modo sem autenticação: um token corrompido
    // no banco tem de explodir aqui, não ser enviado assim para a plataforma.
    const chaveiro = buildKeyring(CHAVE_1);
    const { ciphertext } = encrypt('token', chaveiro);

    const partes = ciphertext.split('.');
    const dados = Buffer.from(partes[3] as string, 'base64');
    dados[0] = (dados[0] ?? 0) ^ 0xff;
    partes[3] = dados.toString('base64');

    expect(() => decrypt(partes.join('.'), chaveiro)).toThrow();
  });

  it('a versão fica gravada junto', () => {
    const chaveiro = buildKeyring(CHAVE_2, { currentVersion: 4 });
    const cifrado = encrypt('token', chaveiro);

    expect(cifrado.keyVersion).toBe(4);
    expect(cifrado.ciphertext.startsWith('v4.')).toBe(true);
  });
});

describe('rotação de chave', () => {
  it('o que foi cifrado com a chave ANTIGA continua decifrando depois da rotação', () => {
    // O teste que teria pego o defeito. Sem ele, a rotação só falharia em
    // produção — e falharia em TODAS as contas ao mesmo tempo.
    const antes = buildKeyring(CHAVE_1);
    const cifradoAntes = encrypt('token-de-antes-da-rotacao', antes);

    const depois = buildKeyring(CHAVE_2, {
      currentVersion: 2,
      previousKeys: { 1: CHAVE_1 },
    });

    expect(decrypt(cifradoAntes.ciphertext, depois)).toBe('token-de-antes-da-rotacao');
  });

  it('o que for cifrado DEPOIS nasce na versão nova', () => {
    const depois = buildKeyring(CHAVE_2, {
      currentVersion: 2,
      previousKeys: { 1: CHAVE_1 },
    });

    const novo = encrypt('token-novo', depois);
    expect(novo.keyVersion).toBe(2);
    expect(decrypt(novo.ciphertext, depois)).toBe('token-novo');
  });

  it('duas rotações seguidas mantêm as duas gerações legíveis', () => {
    const v1 = buildKeyring(CHAVE_1);
    const cifradoV1 = encrypt('geracao-1', v1);

    const v2 = buildKeyring(CHAVE_2, { currentVersion: 2, previousKeys: { 1: CHAVE_1 } });
    const cifradoV2 = encrypt('geracao-2', v2);

    const v3 = buildKeyring(CHAVE_3, {
      currentVersion: 3,
      previousKeys: { 1: CHAVE_1, 2: CHAVE_2 },
    });

    expect(decrypt(cifradoV1.ciphertext, v3)).toBe('geracao-1');
    expect(decrypt(cifradoV2.ciphertext, v3)).toBe('geracao-2');
    expect(decrypt(encrypt('geracao-3', v3).ciphertext, v3)).toBe('geracao-3');
  });

  it('descartar a chave antiga cedo demais falha com mensagem clara', () => {
    // Não é um erro genérico de decifragem: a mensagem tem de dizer o que
    // fazer, porque quem lê está no meio de um incidente.
    const antes = buildKeyring(CHAVE_1);
    const cifrado = encrypt('token', antes);

    const semAntiga = buildKeyring(CHAVE_2, { currentVersion: 2 });

    expect(() => decrypt(cifrado.ciphertext, semAntiga)).toThrow(/versão 1 não está configurada/i);
  });

  it('trocar a chave SEM incrementar a versão é recusado no boot', () => {
    // Este é o modo de falha original. Deixar passar produziria um sistema
    // que sobe normalmente e falha em toda publicação.
    expect(() =>
      buildKeyring(CHAVE_2, { currentVersion: 1, previousKeys: { 1: CHAVE_1 } }),
    ).toThrow(/incremente ENCRYPTION_KEY_VERSION/i);
  });

  it('versão inválida é recusada', () => {
    expect(() => buildKeyring(CHAVE_1, { currentVersion: 0 })).toThrow(/inteiro >= 1/i);
    expect(() => buildKeyring(CHAVE_1, { currentVersion: 1.5 })).toThrow(/inteiro >= 1/i);
  });

  it('chave de tamanho errado é recusada', () => {
    expect(() => buildKeyring(Buffer.alloc(16, 1).toString('base64'))).toThrow(/32 bytes/i);
  });
});

describe('leitura de ENCRYPTION_KEYS_PREVIOUS', () => {
  it('vazio ou ausente é o caso normal', () => {
    expect(parsePreviousKeys(undefined)).toEqual({});
    expect(parsePreviousKeys('')).toEqual({});
    expect(parsePreviousKeys('   ')).toEqual({});
  });

  it('interpreta o mapa de versão para chave', () => {
    expect(parsePreviousKeys(JSON.stringify({ 1: CHAVE_1, 2: CHAVE_2 }))).toEqual({
      1: CHAVE_1,
      2: CHAVE_2,
    });
  });

  it('recusa JSON inválido, formato errado e chave de tamanho errado', () => {
    // Falhar no boot é melhor do que subir e descobrir publicando.
    expect(() => parsePreviousKeys('não é json')).toThrow(/JSON/i);
    expect(() => parsePreviousKeys('[]')).toThrow(/objeto JSON/i);
    expect(() => parsePreviousKeys(JSON.stringify({ 0: CHAVE_1 }))).toThrow(/versão inválida/i);
    expect(() => parsePreviousKeys(JSON.stringify({ 1: 'curta' }))).toThrow(/32 bytes/i);
  });

  it('o resultado alimenta o chaveiro diretamente', () => {
    const chaveiro = buildKeyring(CHAVE_2, {
      currentVersion: 2,
      previousKeys: parsePreviousKeys(JSON.stringify({ 1: CHAVE_1 })),
    });

    const cifradoV1 = encrypt('antigo', buildKeyring(CHAVE_1));
    expect(decrypt(cifradoV1.ciphertext, chaveiro)).toBe('antigo');
  });
});
