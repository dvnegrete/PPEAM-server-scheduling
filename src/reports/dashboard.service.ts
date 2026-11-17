import { Injectable } from '@nestjs/common';
import { AssignmentOrigin, AssignmentStatus, ShiftStatus } from '@prisma/client';
import { captainFirst } from '../common/captain/captain-first';
import { captainOf } from '../common/captain/captain-of';
import { displayName } from '../common/names/person-name';
import { TimeService } from '../common/time/time.service';
import { PrismaService } from '../prisma/prisma.service';
import { OCCUPYING_STATUSES } from '../scheduling/shifts.service';

/** Nivel de necesidad de un turno; define el color con que se pinta en el tablero. */
export type NeedLevel = 'ok' | 'bajoCupo' | 'bajoMinimo' | 'cancelado';

export interface DashboardShift {
  id: string;
  date: string;
  /** «7:00 a 9:00», en 24 h. El panel solo lo usa de respaldo. */
  range: string;
  /** Minutos desde la medianoche local: con ellos el panel redacta la hora. */
  startMinute: number;
  endMinute: number;
  startsAt: string;
  status: ShiftStatus;
  capacity: number;
  occupied: number;
  /** Lugares que faltan para la **meta** del turno; es lo que se convoca. */
  freeSlots: number;
  /**
   * Lugares extra que todavía admite por encima de la meta, hasta el tope del
   * punto. Es una decisión del administrador, no una carencia: no se convoca
   * para llenarlos y no afecta al color del turno.
   */
  extraSlots: number;
  need: NeedLevel;
  participants: Array<{
    assignmentId: string;
    participantId: string;
    name: string;
    /** Cónyuge que también participa; sirve para emparejarlos dentro del turno. */
    spouseId: string | null;
    /** Capitán del turno: va primero, y su cónyuge (si está) en segundo lugar. */
    isCaptain: boolean;
    /** Nota de esa vez, si se capturó al registrarlo. */
    note: string | null;
    origin: AssignmentOrigin;
    confirmed: boolean;
    assignedAt: string | null;
    assignedByName: string | null;
  }>;
  cancellations: Array<{
    participantId: string;
    name: string;
    cancelledAt: string | null;
    reason: string | null;
    reasonCode: string | null;
    cancelledByName: string | null;
  }>;
}

export interface DashboardDay {
  date: string;
  weekday: number;
  label: string;
  shifts: DashboardShift[];
}

export interface DashboardResult {
  from: string;
  to: string;
  timezone: string;
  capacity: number;
  minCapacity: number;
  summary: {
    totalShifts: number;
    understaffed: number;
    critical: number;
    cancellations: number;
  };
  days: DashboardDay[];
}

/** El tablero operativo: la pantalla que se abre a diario. */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly time: TimeService,
  ) {}

  /**
   * Tablero operativo: qué turnos hay en el rango, cómo van de gente y qué se
   * movió en cada uno. Es la pantalla que el administrador abre a diario, así que
   * trae de una sola vez todo lo que necesita ver y no obliga a abrir detalles.
   */
  async dashboard(locationId: string, from: Date, to: Date): Promise<DashboardResult> {
    const location = await this.prisma.location.findUniqueOrThrow({ where: { id: locationId } });

    const shifts = await this.prisma.shift.findMany({
      where: { locationId, startsAt: { gte: from, lte: to } },
      include: {
        assignments: {
          include: {
            participant: {
              select: {
                id: true,
                firstName: true,
                paternalSurname: true,
                maternalSurname: true,
                displayName: true,
                // Con esto el panel puede emparejar a los cónyuges que coinciden
                // en un turno sin ninguna consulta extra: si los dos están, los
                // dos vienen ya en esta misma lista.
                spouseId: true,
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
        // El capitán se resuelve al leer: si canceló, no está entre los
        // ocupantes y el turno queda sin capitán.
        template: {
          select: {
            recurringAssignments: {
              where: { active: true, isCaptain: true },
              select: { participantId: true },
            },
          },
        },
      },
      orderBy: [{ date: 'asc' }, { startMinute: 'asc' }],
    });

    const days = new Map<string, DashboardDay>();
    let understaffed = 0;
    let critical = 0;
    let cancellations = 0;

    for (const shift of shifts) {
      const capitan = captainOf(shift);
      const ocupantes = captainFirst(
        shift.assignments.filter((assignment) => OCCUPYING_STATUSES.includes(assignment.status)),
        capitan,
        (assignment) => assignment.participantId,
        (assignment) => assignment.participant.spouseId,
      );
      const bajas = shift.assignments.filter(
        (assignment) => assignment.status === AssignmentStatus.CANCELLED,
      );
      cancellations += bajas.length;

      const need = this.needLevel(
        shift.status,
        ocupantes.length,
        shift.capacity,
        location.minCapacity,
      );
      if (need === 'bajoMinimo') critical += 1;
      else if (need === 'bajoCupo') understaffed += 1;

      const fecha = shift.date.toISOString().slice(0, 10);
      if (!days.has(fecha)) {
        days.set(fecha, {
          date: fecha,
          weekday: this.time.weekday(shift.date, 'utc'),
          label: this.time.formatDate(shift.date, location.timezone),
          shifts: [],
        });
      }

      days.get(fecha)!.shifts.push({
        id: shift.id,
        date: fecha,
        range: this.time.formatRange(shift.startMinute, shift.endMinute),
        startMinute: shift.startMinute,
        endMinute: shift.endMinute,
        startsAt: shift.startsAt.toISOString(),
        status: shift.status,
        capacity: shift.capacity,
        occupied: ocupantes.length,
        freeSlots: Math.max(0, shift.capacity - ocupantes.length),
        // Se mide desde la meta, no desde la ocupación: con 2 de 3 hay 1 lugar
        // por convocar y 1 extra detrás, no 2 extra.
        extraSlots: Math.max(
          0,
          Math.max(shift.capacity, location.maxCapacity) -
            Math.max(ocupantes.length, shift.capacity),
        ),
        need,
        participants: ocupantes.map((assignment) => ({
          assignmentId: assignment.id,
          participantId: assignment.participant.id,
          name: displayName(assignment.participant),
          spouseId: assignment.participant.spouseId,
          isCaptain: assignment.participantId === capitan,
          note: assignment.note,
          origin: assignment.origin,
          confirmed: assignment.status === AssignmentStatus.CONFIRMED,
          assignedAt: assignment.assignedAt?.toISOString() ?? null,
          assignedByName: assignment.assignedByName,
        })),
        cancellations: bajas.map((assignment) => ({
          participantId: assignment.participant.id,
          name: displayName(assignment.participant),
          cancelledAt: assignment.cancelledAt?.toISOString() ?? null,
          reason: assignment.cancelReason,
          reasonCode: assignment.cancelReasonCode,
          cancelledByName: assignment.cancelledByName,
        })),
      });
    }

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      timezone: location.timezone,
      capacity: location.defaultCapacity,
      minCapacity: location.minCapacity,
      summary: {
        totalShifts: shifts.length,
        understaffed,
        critical,
        cancellations,
      },
      days: [...days.values()],
    };
  }

  /** Clasificación que pinta el color del turno en el tablero. */
  private needLevel(
    status: ShiftStatus,
    occupied: number,
    capacity: number,
    minCapacity: number,
  ): NeedLevel {
    if (status === ShiftStatus.CANCELLED) return 'cancelado';
    if (occupied < minCapacity) return 'bajoMinimo';
    if (occupied < capacity) return 'bajoCupo';
    return 'ok';
  }
}
