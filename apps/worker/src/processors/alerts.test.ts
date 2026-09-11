import { describe, expect, it } from 'vitest';
import { evaluateAlerts, type AlertSnapshot, type AlertThresholds } from './alerts.js';

/**
 * Avaliação dos alertas operacionais.
 *
 * A função é pura de propósito: é nela que mora a decisão de acordar alguém
 * às 3 da manhã. O que precisa ser provado é que ela dispara quando tem de
 * disparar — e, sobretudo, que ela NÃO dispara por ruído, porque um alerta
 * que grita à toa é ignorado em duas semanas.
 */

const LIMIARES: AlertThresholds = {
  failureRatePercent: 25,
  failureMinSample: 10,
  deadLetterOpen: 10,
  queueWaiting: 500,
  accountsNeedingReconnect: 5,
  cooldownMinutes: 60,
};

function snapshot(parcial: Partial<AlertSnapshot> = {}): AlertSnapshot {
  return {
    circuits: [],
    deadLetterOpen: 0,
    queues: [],
    publishOutcomes: [],
    accountsNeedingReconnect: 0,
    ...parcial,
  };
}

describe('ambiente saudável', () => {
  it('não dispara nada quando está tudo dentro dos limiares', () => {
    const alertas = evaluateAlerts(
      snapshot({
        circuits: [{ platform: 'YOUTUBE', state: 'CLOSED', failureCount: 0 }],
        deadLetterOpen: 9,
        queues: [{ name: 'publish', waiting: 499, active: 5, failed: 0 }],
        publishOutcomes: [{ platform: 'YOUTUBE', failed: 2, published: 98 }],
        accountsNeedingReconnect: 4,
      }),
      LIMIARES,
    );

    expect(alertas).toEqual([]);
  });
});

describe('circuito aberto', () => {
  it('dispara sem depender de limiar', () => {
    // Circuito aberto já É a decisão de parar de chamar a plataforma: não
    // existe um "pouco aberto" que dispense aviso.
    const alertas = evaluateAlerts(
      snapshot({
        circuits: [
          { platform: 'INSTAGRAM', state: 'OPEN', failureCount: 7 },
          { platform: 'YOUTUBE', state: 'CLOSED', failureCount: 0 },
        ],
      }),
      LIMIARES,
    );

    expect(alertas).toHaveLength(1);
    expect(alertas[0]?.key).toBe('circuit:INSTAGRAM');
    expect(alertas[0]?.severity).toBe('CRITICAL');
    expect(alertas[0]?.body).toContain('7 falhas');
  });

  it('HALF_OPEN não dispara — é o circuito se recuperando', () => {
    const alertas = evaluateAlerts(
      snapshot({ circuits: [{ platform: 'X', state: 'HALF_OPEN', failureCount: 5 }] }),
      LIMIARES,
    );

    expect(alertas).toEqual([]);
  });
});

describe('taxa de falha por plataforma', () => {
  it('dispara acima do limiar', () => {
    const alertas = evaluateAlerts(
      snapshot({ publishOutcomes: [{ platform: 'TIKTOK', failed: 40, published: 60 }] }),
      LIMIARES,
    );

    expect(alertas).toHaveLength(1);
    expect(alertas[0]?.key).toBe('failure-rate:TIKTOK');
    expect(alertas[0]?.title).toContain('40%');
  });

  it('amostra pequena NÃO dispara, mesmo com 100% de falha', () => {
    // Uma falha em uma tentativa é 100% e não significa nada. Sem este piso,
    // a primeira publicação com erro de uma rede nova acordaria a operação.
    const alertas = evaluateAlerts(
      snapshot({ publishOutcomes: [{ platform: 'FACEBOOK', failed: 3, published: 0 }] }),
      LIMIARES,
    );

    expect(alertas).toEqual([]);
  });

  it('a amostra mínima conta falhas E sucessos juntos', () => {
    // 3 falhas + 7 sucessos = 10, atinge o piso; 30% passa do limiar de 25%.
    const alertas = evaluateAlerts(
      snapshot({ publishOutcomes: [{ platform: 'FACEBOOK', failed: 3, published: 7 }] }),
      LIMIARES,
    );

    expect(alertas).toHaveLength(1);
    expect(alertas[0]?.title).toContain('30%');
  });

  it('cada plataforma é avaliada por si', () => {
    // Uma rede com problema não pode esconder nem contaminar as outras: a
    // cota, o token e a API são de cada uma.
    const alertas = evaluateAlerts(
      snapshot({
        publishOutcomes: [
          { platform: 'YOUTUBE', failed: 1, published: 99 },
          { platform: 'TIKTOK', failed: 50, published: 50 },
        ],
      }),
      LIMIARES,
    );

    expect(alertas.map((alerta) => alerta.key)).toEqual(['failure-rate:TIKTOK']);
  });

  it('o limiar vem da configuração, não do código', () => {
    const dados = snapshot({
      publishOutcomes: [{ platform: 'YOUTUBE', failed: 2, published: 18 }],
    });

    expect(evaluateAlerts(dados, LIMIARES)).toEqual([]);
    expect(evaluateAlerts(dados, { ...LIMIARES, failureRatePercent: 10 })).toHaveLength(1);
  });
});

describe('dead-letter, filas e reconexões', () => {
  it('dead-letter acumulada dispara como crítico', () => {
    const alertas = evaluateAlerts(snapshot({ deadLetterOpen: 12 }), LIMIARES);

    expect(alertas).toHaveLength(1);
    expect(alertas[0]?.key).toBe('dead-letter');
    expect(alertas[0]?.severity).toBe('CRITICAL');
  });

  it('fila crescendo é aviso, não crítico', () => {
    // A publicação ainda vai sair — só pode atrasar. Tratar como crítico
    // igualaria isso a "não publicou".
    const alertas = evaluateAlerts(
      snapshot({ queues: [{ name: 'publish', waiting: 800, active: 5, failed: 0 }] }),
      LIMIARES,
    );

    expect(alertas).toHaveLength(1);
    expect(alertas[0]?.key).toBe('queue:publish');
    expect(alertas[0]?.severity).toBe('WARNING');
  });

  it('cada fila tem sua própria chave de alerta', () => {
    const alertas = evaluateAlerts(
      snapshot({
        queues: [
          { name: 'publish', waiting: 900, active: 5, failed: 0 },
          { name: 'media-processing', waiting: 600, active: 2, failed: 0 },
          { name: 'reports', waiting: 3, active: 0, failed: 0 },
        ],
      }),
      LIMIARES,
    );

    expect(alertas.map((alerta) => alerta.key).sort()).toEqual([
      'queue:media-processing',
      'queue:publish',
    ]);
  });

  it('contas pedindo reconexão disparam aviso', () => {
    const alertas = evaluateAlerts(snapshot({ accountsNeedingReconnect: 5 }), LIMIARES);

    expect(alertas).toHaveLength(1);
    expect(alertas[0]?.key).toBe('accounts-needing-reconnect');
    expect(alertas[0]?.severity).toBe('WARNING');
  });
});

describe('ordenação', () => {
  it('o mais grave vem primeiro', () => {
    // Quem abre o e-mail às 3 da manhã lê de cima para baixo.
    const alertas = evaluateAlerts(
      snapshot({
        circuits: [{ platform: 'YOUTUBE', state: 'OPEN', failureCount: 5 }],
        queues: [{ name: 'publish', waiting: 900, active: 1, failed: 0 }],
        accountsNeedingReconnect: 9,
        deadLetterOpen: 40,
      }),
      LIMIARES,
    );

    const severidades = alertas.map((alerta) => alerta.severity);
    expect(severidades.indexOf('WARNING')).toBeGreaterThan(severidades.lastIndexOf('CRITICAL'));
    expect(alertas).toHaveLength(4);
  });

  it('as chaves são estáveis — é delas que depende o silêncio pós-disparo', () => {
    // Se a chave mudasse entre rodadas, o mesmo problema mandaria um e-mail a
    // cada 5 minutos.
    const dados = snapshot({
      circuits: [{ platform: 'YOUTUBE', state: 'OPEN', failureCount: 5 }],
      deadLetterOpen: 40,
    });

    expect(evaluateAlerts(dados, LIMIARES).map((alerta) => alerta.key)).toEqual(
      evaluateAlerts(dados, LIMIARES).map((alerta) => alerta.key),
    );
    expect(evaluateAlerts(dados, LIMIARES).map((alerta) => alerta.key)).toEqual([
      'circuit:YOUTUBE',
      'dead-letter',
    ]);
  });
});
