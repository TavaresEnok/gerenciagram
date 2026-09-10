import { describe, expect, it } from 'vitest';
import {
  describeTimezoneDivergence,
  formatInTimezone,
  localIsoToUtc,
  utcToWallTime,
  wallTimeToUtc,
  weekdayInTimezone,
} from './timezone.js';
import { findNextFreeSlot, formatSlot, normalizeSlots, resolveQueueSlotsForAccounts } from './slots.js';

describe('fuso horário', () => {
  it('interpreta a hora de parede no fuso da conta, não no do servidor', () => {
    // São Paulo está em UTC-3 (sem horário de verão desde 2019).
    const utc = wallTimeToUtc(
      { year: 2026, month: 9, day: 14, hour: 10, minute: 0 },
      'America/Sao_Paulo',
    );
    expect(utc.toISOString()).toBe('2026-09-14T13:00:00.000Z');
  });

  it('produz instantes DIFERENTES para a mesma hora de parede em fusos diferentes', () => {
    // O caso que a SPEC seção 6.1 destaca: "segunda às 10h" para um grupo com
    // contas em fusos distintos NÃO é o mesmo instante.
    const wall = { year: 2026, month: 9, day: 14, hour: 10, minute: 0 };

    const saoPaulo = wallTimeToUtc(wall, 'America/Sao_Paulo'); // UTC-3
    const manaus = wallTimeToUtc(wall, 'America/Manaus'); // UTC-4
    const lisboa = wallTimeToUtc(wall, 'Europe/Lisbon'); // UTC+1 no verão

    expect(saoPaulo.toISOString()).toBe('2026-09-14T13:00:00.000Z');
    expect(manaus.toISOString()).toBe('2026-09-14T14:00:00.000Z');
    expect(lisboa.toISOString()).toBe('2026-09-14T09:00:00.000Z');

    const divergence = describeTimezoneDivergence([
      { label: 'SP', timezone: 'America/Sao_Paulo', instant: saoPaulo },
      { label: 'MAO', timezone: 'America/Manaus', instant: manaus },
      { label: 'LIS', timezone: 'Europe/Lisbon', instant: lisboa },
    ]);
    expect(divergence.diverges).toBe(true);
    expect(divergence.distinctInstants).toBe(3);
  });

  it('acerta o horário de verão de um fuso que ainda o pratica', () => {
    // Nova York: EST (UTC-5) no inverno, EDT (UTC-4) no verão.
    const inverno = wallTimeToUtc(
      { year: 2026, month: 1, day: 15, hour: 9, minute: 0 },
      'America/New_York',
    );
    const verao = wallTimeToUtc(
      { year: 2026, month: 7, day: 15, hour: 9, minute: 0 },
      'America/New_York',
    );

    expect(inverno.toISOString()).toBe('2026-01-15T14:00:00.000Z');
    expect(verao.toISOString()).toBe('2026-07-15T13:00:00.000Z');
  });

  it('ida e volta preserva a hora de parede', () => {
    const wall = { year: 2026, month: 3, day: 2, hour: 18, minute: 30 };
    const utc = wallTimeToUtc(wall, 'America/Sao_Paulo');
    expect(utcToWallTime(utc, 'America/Sao_Paulo')).toEqual(wall);
  });

  it('rejeita fuso inválido em vez de assumir UTC silenciosamente', () => {
    expect(() =>
      wallTimeToUtc({ year: 2026, month: 1, day: 1, hour: 0, minute: 0 }, 'Marte/Olympus'),
    ).toThrow(/Fuso horário inválido/);
  });

  it('exibe o fuso junto do horário, como a SPEC exige', () => {
    const utc = localIsoToUtc('2026-09-14T10:00', 'America/Sao_Paulo');
    const formatted = formatInTimezone(utc, 'America/Sao_Paulo');
    expect(formatted.dateTime).toBe('14/09/2026 às 10:00');
    expect(formatted.full).toContain('America/Sao_Paulo');
  });

  it('usa 0 = domingo para casar com a grade de slots', () => {
    // 2026-09-14 é uma segunda-feira.
    const segunda = localIsoToUtc('2026-09-14T10:00', 'America/Sao_Paulo');
    expect(weekdayInTimezone(segunda, 'America/Sao_Paulo')).toBe(1);

    const domingo = localIsoToUtc('2026-09-13T10:00', 'America/Sao_Paulo');
    expect(weekdayInTimezone(domingo, 'America/Sao_Paulo')).toBe(0);
  });
});

describe('fila por slots', () => {
  const slots = [
    { weekday: 1, hour: 10, minute: 0 }, // segunda 10h
    { weekday: 1, hour: 18, minute: 0 }, // segunda 18h
    { weekday: 2, hour: 12, minute: 0 }, // terça 12h
    { weekday: 3, hour: 20, minute: 0 }, // quarta 20h
  ];

  it('normaliza removendo duplicatas e ordenando', () => {
    const normalized = normalizeSlots([
      { weekday: 3, hour: 20, minute: 0 },
      { weekday: 1, hour: 10, minute: 0 },
      { weekday: 1, hour: 10, minute: 0 },
    ]);
    expect(normalized).toEqual([
      { weekday: 1, hour: 10, minute: 0 },
      { weekday: 3, hour: 20, minute: 0 },
    ]);
  });

  it('encontra o próximo slot no fuso da conta', () => {
    // Domingo 13/09/2026, 12h em São Paulo.
    const from = localIsoToUtc('2026-09-13T12:00', 'America/Sao_Paulo');
    const next = findNextFreeSlot({
      slots,
      timezone: 'America/Sao_Paulo',
      from,
      occupied: [],
    });
    // Segunda 14/09 às 10h em SP = 13h UTC.
    expect(next?.toISOString()).toBe('2026-09-14T13:00:00.000Z');
  });

  it('pula slots já ocupados por outros destinos da mesma conta', () => {
    const from = localIsoToUtc('2026-09-13T12:00', 'America/Sao_Paulo');
    const segunda10 = localIsoToUtc('2026-09-14T10:00', 'America/Sao_Paulo');
    const segunda18 = localIsoToUtc('2026-09-14T18:00', 'America/Sao_Paulo');

    const next = findNextFreeSlot({
      slots,
      timezone: 'America/Sao_Paulo',
      from,
      occupied: [segunda10, segunda18],
    });

    // Deve cair na terça 12h.
    expect(next?.toISOString()).toBe(localIsoToUtc('2026-09-15T12:00', 'America/Sao_Paulo').toISOString());
  });

  it('avança para a semana seguinte quando a semana atual acabou', () => {
    // Quinta-feira: nenhum slot restante nesta semana.
    const from = localIsoToUtc('2026-09-17T09:00', 'America/Sao_Paulo');
    const next = findNextFreeSlot({ slots, timezone: 'America/Sao_Paulo', from, occupied: [] });
    expect(next?.toISOString()).toBe(
      localIsoToUtc('2026-09-21T10:00', 'America/Sao_Paulo').toISOString(),
    );
  });

  it('resolve slots por conta, cada uma no seu fuso', () => {
    const from = localIsoToUtc('2026-09-13T12:00', 'America/Sao_Paulo');

    const resolutions = resolveQueueSlotsForAccounts(
      [
        {
          accountId: 'a1',
          accountLabel: 'TikTok 1 – Curiosidades',
          timezone: 'America/Sao_Paulo',
          slots,
          occupied: [],
        },
        {
          accountId: 'a2',
          accountLabel: 'TikTok 2 – Curiosidades',
          timezone: 'America/Manaus',
          slots,
          occupied: [],
        },
      ],
      from,
    );

    // Mesma grade "segunda 10h", instantes UTC diferentes por causa do fuso.
    expect(resolutions[0]?.scheduledAt?.toISOString()).toBe('2026-09-14T13:00:00.000Z');
    expect(resolutions[1]?.scheduledAt?.toISOString()).toBe('2026-09-14T14:00:00.000Z');
  });

  it('conta sem grade não derruba as outras do grupo', () => {
    const from = localIsoToUtc('2026-09-13T12:00', 'America/Sao_Paulo');

    const resolutions = resolveQueueSlotsForAccounts(
      [
        { accountId: 'a1', accountLabel: 'Com grade', timezone: 'America/Sao_Paulo', slots, occupied: [] },
        { accountId: 'a2', accountLabel: 'Sem grade', timezone: 'America/Sao_Paulo', slots: [], occupied: [] },
      ],
      from,
    );

    expect(resolutions[0]?.scheduledAt).toBeInstanceOf(Date);
    expect(resolutions[1]?.scheduledAt).toBeNull();
    expect(resolutions[1]?.reason).toContain('grade de horários');
  });

  it('formata o slot em português', () => {
    expect(formatSlot({ weekday: 1, hour: 10, minute: 0 })).toBe('Segunda às 10:00');
    expect(formatSlot({ weekday: 0, hour: 9, minute: 5 })).toBe('Domingo às 09:05');
  });
});
