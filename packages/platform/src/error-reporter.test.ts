import { describe, expect, it } from 'vitest';
import { createErrorReporter } from './error-reporter.js';

/**
 * O relator só tem um comportamento que dá para provar sem uma conta no
 * Sentry — e é o que mais importa: sem DSN, ele NÃO liga nada e NÃO finge.
 *
 * O caminho com DSN não é testado aqui de propósito: exercitá-lo enviaria
 * eventos por rede para um endereço real ou falso, e um teste que depende de
 * rede externa é um teste que falha por motivo que não é o código.
 */

describe('relator de erros sem SENTRY_DSN', () => {
  it('fica desligado quando o DSN está ausente', () => {
    const relator = createErrorReporter({ environment: 'test', serviceName: 'teste' });
    expect(relator.enabled).toBe(false);
  });

  it('DSN em branco conta como ausente', () => {
    // Um `SENTRY_DSN=` vazio no .env é o caso mais comum — e ligar o SDK com
    // string vazia é o tipo de erro que só aparece em produção.
    const relator = createErrorReporter({ dsn: '   ', environment: 'test', serviceName: 'teste' });
    expect(relator.enabled).toBe(false);
  });

  it('capturar e fechar desligado não lança nem faz nada', async () => {
    const relator = createErrorReporter({ environment: 'test', serviceName: 'teste' });

    expect(() =>
      relator.capture(new Error('não deve sair daqui'), {
        correlationId: 'c-1',
        organizationId: null,
        tags: { queue: 'publish' },
        extra: { tentativa: 3 },
      }),
    ).not.toThrow();

    await expect(relator.close()).resolves.toBeUndefined();
  });

  it('aceita erro que não é Error, como vem de unhandledRejection', () => {
    // `unhandledRejection` entrega `unknown`: pode ser string, objeto ou nada.
    const relator = createErrorReporter({ environment: 'test', serviceName: 'teste' });
    expect(() => relator.capture('rejeitado com string')).not.toThrow();
    expect(() => relator.capture(undefined)).not.toThrow();
  });
});
