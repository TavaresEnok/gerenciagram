import { DateTime } from 'luxon';
import { z } from 'zod';
import { ValidationError } from '../errors.js';
import { assertValidTimezone } from './timezone.js';

/**
 * Fila por slots (SPEC seção 6.1, modelo do Buffer).
 *
 * Cada CONTA tem uma grade semanal de horários no seu próprio fuso. O grupo é
 * só um atalho para configurar a grade de várias contas de uma vez — a grade
 * mora na conta, porque o fuso mora na conta.
 *
 * "Adicionar à fila" coloca a publicação no próximo slot LIVRE da conta:
 * livre = nenhum outro destino daquela conta já ocupa aquele instante.
 */

export const queueSlotSchema = z.object({
  /** 0 = domingo ... 6 = sábado, no fuso da conta. */
  weekday: z.number().int().min(0).max(6),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
});

export type QueueSlot = z.infer<typeof queueSlotSchema>;

export const queueSlotsSchema = z.array(queueSlotSchema);

/** Ordena e remove duplicatas — a grade é um conjunto, não uma lista. */
export function normalizeSlots(slots: QueueSlot[]): QueueSlot[] {
  const seen = new Set<string>();
  const result: QueueSlot[] = [];
  for (const slot of slots) {
    const key = `${slot.weekday}-${slot.hour}-${slot.minute}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(slot);
  }
  return result.sort(
    (a, b) => a.weekday - b.weekday || a.hour - b.hour || a.minute - b.minute,
  );
}

export interface NextSlotOptions {
  slots: QueueSlot[];
  timezone: string;
  /** A partir de quando procurar (normalmente "agora"). */
  from: Date;
  /** Instantes UTC já ocupados por outros destinos DESTA conta. */
  occupied: Date[];
  /** Quantas semanas procurar antes de desistir. */
  maxWeeks?: number;
}

/**
 * Próximo slot livre da conta, em UTC.
 *
 * A busca é feita em horas de parede no fuso da conta e só depois convertida
 * para UTC — o caminho inverso erraria na semana da virada de horário de
 * verão, quando o offset muda no meio do intervalo procurado.
 */
export function findNextFreeSlot(options: NextSlotOptions): Date | null {
  const { slots, timezone, from, occupied, maxWeeks = 8 } = options;
  assertValidTimezone(timezone);

  const normalized = normalizeSlots(slots);
  if (normalized.length === 0) return null;

  const occupiedMs = new Set(occupied.map((d) => d.getTime()));
  const fromMs = from.getTime();

  const startOfWeek = DateTime.fromJSDate(from, { zone: 'utc' })
    .setZone(timezone)
    .startOf('day')
    // Recuar até o domingo da semana corrente (weekday 7 = domingo no Luxon).
    .minus({ days: DateTime.fromJSDate(from, { zone: 'utc' }).setZone(timezone).weekday % 7 });

  for (let week = 0; week < maxWeeks; week += 1) {
    for (const slot of normalized) {
      const candidate = startOfWeek.plus({ weeks: week, days: slot.weekday }).set({
        hour: slot.hour,
        minute: slot.minute,
        second: 0,
        millisecond: 0,
      });

      if (!candidate.isValid) continue;

      const candidateUtc = candidate.toUTC().toJSDate();
      const candidateMs = candidateUtc.getTime();

      if (candidateMs <= fromMs) continue;
      if (occupiedMs.has(candidateMs)) continue;

      return candidateUtc;
    }
  }

  return null;
}

/**
 * Resolve um slot para CADA conta de uma vez.
 *
 * Cada conta tem sua própria grade, seu próprio fuso e seus próprios horários
 * ocupados — por isso o resultado é por conta, e uma conta sem grade
 * configurada não derruba as outras (SPEC seção 12: falha de um destino não
 * afeta os demais).
 */
export interface AccountQueueInput {
  accountId: string;
  accountLabel: string;
  timezone: string;
  slots: QueueSlot[];
  occupied: Date[];
}

export interface AccountQueueResolution {
  accountId: string;
  accountLabel: string;
  scheduledAt: Date | null;
  timezone: string;
  slot: QueueSlot | null;
  /** Preenchido quando `scheduledAt` é nulo. */
  reason?: string;
}

export function resolveQueueSlotsForAccounts(
  accounts: AccountQueueInput[],
  from: Date,
): AccountQueueResolution[] {
  return accounts.map((account) => {
    if (account.slots.length === 0) {
      return {
        accountId: account.accountId,
        accountLabel: account.accountLabel,
        scheduledAt: null,
        timezone: account.timezone,
        slot: null,
        reason:
          'Esta conta não tem grade de horários configurada. ' +
          'Defina os slots da fila antes de usar "adicionar à fila".',
      };
    }

    const scheduledAt = findNextFreeSlot({
      slots: account.slots,
      timezone: account.timezone,
      from,
      occupied: account.occupied,
    });

    if (!scheduledAt) {
      return {
        accountId: account.accountId,
        accountLabel: account.accountLabel,
        scheduledAt: null,
        timezone: account.timezone,
        slot: null,
        reason:
          'Nenhum slot livre nas próximas 8 semanas. Adicione horários à grade ' +
          'desta conta ou escolha um horário específico.',
      };
    }

    return {
      accountId: account.accountId,
      accountLabel: account.accountLabel,
      scheduledAt,
      timezone: account.timezone,
      slot: slotOf(scheduledAt, account.timezone),
    };
  });
}

function slotOf(instant: Date, timezone: string): QueueSlot {
  const dt = DateTime.fromJSDate(instant, { zone: 'utc' }).setZone(timezone);
  return { weekday: dt.weekday % 7, hour: dt.hour, minute: dt.minute };
}

export function parseSlots(raw: unknown): QueueSlot[] {
  const parsed = queueSlotsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Grade de horários inválida', parsed.error.flatten());
  }
  return normalizeSlots(parsed.data);
}

const WEEKDAY_LABELS = [
  'Domingo',
  'Segunda',
  'Terça',
  'Quarta',
  'Quinta',
  'Sexta',
  'Sábado',
] as const;

export function formatSlot(slot: QueueSlot): string {
  const label = WEEKDAY_LABELS[slot.weekday] ?? '?';
  const hh = String(slot.hour).padStart(2, '0');
  const mm = String(slot.minute).padStart(2, '0');
  return `${label} às ${hh}:${mm}`;
}
