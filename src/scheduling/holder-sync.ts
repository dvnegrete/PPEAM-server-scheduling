import { AssignmentStatus, ShiftStatus } from '@prisma/client';
import { OCCUPYING_STATUSES } from './shifts.service';

/**
 * Qué decide el calendario sobre los titulares fijos de un turno ya creado.
 *
 * Son funciones puras: reciben lo que hay en el turno y quiénes son titulares, y
 * dicen qué hacer. Quien escribe en la base es el generador; así la misma regla
 * sirve para aplicar los cambios y para anticipar cuántos habrá.
 */

/** Lo que importa de un turno para decidir si se toca. */
export interface SyncShift {
  capacity: number;
  status: ShiftStatus;
  startsAt: Date;
}

/** Quién figura ya en el turno y en qué situación. */
export interface SyncAssignment {
  participantId: string;
  status: AssignmentStatus;
}

/** Un titular fijo, con la vigencia de su asignación. */
export interface SyncHolder {
  participantId: string;
  startsOn: Date | null;
  endsOn: Date | null;
}

/**
 * Un turno cancelado no se repuebla, y el pasado no se reescribe: sentar a
 * alguien en un turno que ya ocurrió falsearía el historial de asistencia.
 */
export function canBeFilled(shift: Pick<SyncShift, 'status' | 'startsAt'>, now: Date): boolean {
  return shift.status !== ShiftStatus.CANCELLED && shift.startsAt >= now;
}

/** Respeta las vigencias de la asignación fija (altas y bajas a mitad de año). */
export function isHolderOn(holder: Pick<SyncHolder, 'startsOn' | 'endsOn'>, date: Date): boolean {
  if (holder.startsOn && date < holder.startsOn) return false;
  if (holder.endsOn && date > holder.endsOn) return false;
  return true;
}

/**
 * Qué titulares vigentes caben todavía en el turno y no figuran ya en él.
 *
 * Quien ya figura —sentado o con una baja— no se vuelve a tocar: si alguien
 * canceló ese día, esa decisión vale más que la regla.
 */
export function holdersToSeat<T extends SyncHolder>(
  shift: SyncShift,
  assignments: SyncAssignment[],
  holders: T[],
  date: Date,
  now: Date,
): T[] {
  if (!canBeFilled(shift, now)) return [];

  const occupied = assignments.filter((a) => OCCUPYING_STATUSES.includes(a.status)).length;
  const free = shift.capacity - occupied;
  if (free <= 0) return [];

  const alreadyListed = new Set(assignments.map((a) => a.participantId));

  return holders
    .filter((holder) => isHolderOn(holder, date))
    .filter((holder) => !alreadyListed.has(holder.participantId))
    .slice(0, free);
}
