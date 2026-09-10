import { DateTime } from 'luxon';
import { ValidationError } from '../errors.js';

/**
 * Fuso horário (SPEC seção 6.1).
 *
 * Regra única do sistema: **todo horário é persistido em UTC** e interpretado
 * no fuso da CONTA DE DESTINO — nunca no fuso do navegador de quem agendou.
 * "Segunda às 10h" para um grupo com contas em São Paulo e em Manaus são dois
 * instantes UTC diferentes.
 *
 * Usamos Luxon porque a conversão precisa acertar horário de verão: contas de
 * outros países ainda têm DST, e a mesma hora de parede pode não existir (na
 * virada para o horário de verão) ou existir duas vezes (na volta). Fazer isso
 * "na mão" com offsets fixos produz posts publicados uma hora errados duas
 * vezes por ano.
 */

export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export function isValidTimezone(timezone: string): boolean {
  return DateTime.local().setZone(timezone).isValid;
}

export function assertValidTimezone(timezone: string): void {
  if (!isValidTimezone(timezone)) {
    throw new ValidationError(`Fuso horário inválido: "${timezone}"`, { timezone });
  }
}

/**
 * Converte uma hora de parede no fuso da conta para o instante UTC.
 *
 * Ambiguidades de DST são resolvidas de forma explícita e documentada:
 *  - hora inexistente (salto para frente): Luxon avança para o instante
 *    seguinte válido — o post sai logo após a virada, nunca é perdido;
 *  - hora repetida (volta atrás): usamos a PRIMEIRA ocorrência, para o post
 *    não sair uma hora depois do que o usuário viu na tela.
 */
export function wallTimeToUtc(wall: WallTime, timezone: string): Date {
  assertValidTimezone(timezone);

  const dt = DateTime.fromObject(
    {
      year: wall.year,
      month: wall.month,
      day: wall.day,
      hour: wall.hour,
      minute: wall.minute,
      second: 0,
      millisecond: 0,
    },
    { zone: timezone },
  );

  if (!dt.isValid) {
    throw new ValidationError(
      `Não foi possível interpretar ${wall.year}-${wall.month}-${wall.day} ` +
        `${wall.hour}:${wall.minute} no fuso ${timezone}: ${dt.invalidReason}`,
      { wall, timezone },
    );
  }

  return dt.toUTC().toJSDate();
}

/** Interpreta uma string local ("2026-09-14T10:00") no fuso informado. */
export function localIsoToUtc(localIso: string, timezone: string): Date {
  assertValidTimezone(timezone);
  const dt = DateTime.fromISO(localIso, { zone: timezone, setZone: true });
  if (!dt.isValid) {
    throw new ValidationError(`Data/hora inválida: "${localIso}"`, { localIso, timezone });
  }
  return dt.toUTC().toJSDate();
}

/** Hora de parede correspondente a um instante UTC, no fuso da conta. */
export function utcToWallTime(instant: Date, timezone: string): WallTime {
  assertValidTimezone(timezone);
  const dt = DateTime.fromJSDate(instant, { zone: 'utc' }).setZone(timezone);
  return {
    year: dt.year,
    month: dt.month,
    day: dt.day,
    hour: dt.hour,
    minute: dt.minute,
  };
}

/**
 * Rótulo para a UI. Mostrar o fuso junto é exigência da SPEC seção 6.1 —
 * sem ele, "10:00" é ambíguo numa lista com contas de fusos diferentes.
 */
export function formatInTimezone(
  instant: Date,
  timezone: string,
  locale = 'pt-BR',
): { dateTime: string; offsetName: string; full: string } {
  assertValidTimezone(timezone);
  const dt = DateTime.fromJSDate(instant, { zone: 'utc' }).setZone(timezone).setLocale(locale);
  const dateTime = dt.toFormat("dd/MM/yyyy 'às' HH:mm");
  const offsetName = dt.toFormat('ZZ');
  return { dateTime, offsetName, full: `${dateTime} (${timezone}, UTC${offsetName})` };
}

/** 0 = domingo, para casar com `PostingSchedule.slots`. */
export function weekdayInTimezone(instant: Date, timezone: string): number {
  assertValidTimezone(timezone);
  // Luxon usa 1=segunda..7=domingo; normalizamos para 0=domingo..6=sábado.
  const luxonWeekday = DateTime.fromJSDate(instant, { zone: 'utc' }).setZone(timezone).weekday;
  return luxonWeekday % 7;
}

/**
 * Duas contas em fusos diferentes recebendo "segunda às 10h" produzem
 * instantes UTC distintos. A UI usa isto para explicar a diferença em vez de
 * o usuário descobrir depois que os posts saíram em horários diferentes.
 */
export function describeTimezoneDivergence(
  entries: Array<{ label: string; timezone: string; instant: Date }>,
): { diverges: boolean; distinctInstants: number } {
  const unique = new Set(entries.map((e) => e.instant.getTime()));
  return { diverges: unique.size > 1, distinctInstants: unique.size };
}
