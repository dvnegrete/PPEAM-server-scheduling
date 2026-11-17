import { Injectable } from '@nestjs/common';
import { AssignmentOrigin, ParticipantStatus, ShiftStatus } from '@prisma/client';
import { captainFirst } from '../common/captain/captain-first';
import { captainOf } from '../common/captain/captain-of';
import { rosterName } from '../common/names/person-name';
import { formatNationalPhone } from '../common/phone/phone.service';
import { TimeService } from '../common/time/time.service';
import { PrismaService } from '../prisma/prisma.service';
import { OCCUPYING_STATUSES } from '../scheduling/shifts.service';
import { DIAS_DEL_ROL, ORDINALES_DEL_ROL } from './schedule-labels';

/** Una persona tal como aparece en el rol del mes. */
export interface RosterPerson {
  /** «Ana María López»: dos nombres como máximo y el apellido paterno. */
  name: string;
  /** «55 1234 5678», para que cualquiera pueda llamar a su turno o al de al lado. */
  phone: string;
  /** Capitán del turno; siempre es el primero de la lista. */
  isCaptain: boolean;
}

/** Un turno del rol: el horario y quién va. */
export interface RosterSlot {
  startMinute: number;
  /** «7 a 9 am», «11 am a 1 pm». */
  range: string;
  people: RosterPerson[];
  /** Lugares que faltan para completar el cupo. */
  missing: number;
}

/**
 * Un bloque del rol: un día entre semana («Lunes», válido para todo el mes) o
 * una fecha de fin de semana («Primer sábado», «7 de noviembre de 2026»).
 */
export interface RosterDay {
  title: string;
  /** La fecha, solo en fines de semana. */
  subtitle: string | null;
  slots: RosterSlot[];
}

export interface RosterMonth {
  locationName: string;
  year: number;
  month: number;
  /** «noviembre 2026». */
  monthLabel: string;
  /** Lunes a viernes, en ese orden. */
  weekdays: RosterDay[];
  /** Primer sábado, primer domingo, segundo sábado, … */
  weekends: RosterDay[];
}

/** El rol del mes: la imagen que se comparte en el grupo. */
@Injectable()
export class MonthRosterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly time: TimeService,
  ) {}

  /**
   * Rol del mes para compartir en el grupo.
   *
   * Entre semana los turnos se repiten idénticos cada semana, así que va un
   * bloque por día con sus titulares. El fin de semana cambia de gente según el
   * ordinal del mes, así que va fecha por fecha: primer sábado, primer domingo,
   * segundo sábado… En el fin de semana quien canceló ya no figura.
   */
  async monthRoster(locationId: string, year: number, month: number): Promise<RosterMonth> {
    const location = await this.prisma.location.findUniqueOrThrow({ where: { id: locationId } });
    const start = this.time
      .nowInZone(location.timezone)
      .set({ year, month, day: 1 })
      .startOf('month');

    const shifts = await this.prisma.shift.findMany({
      where: {
        locationId,
        date: {
          gte: this.time.toDateColumn(start),
          lte: this.time.toDateColumn(start.endOf('month')),
        },
      },
      include: {
        assignments: {
          include: {
            participant: {
              select: {
                id: true,
                firstName: true,
                paternalSurname: true,
                phoneE164: true,
                spouseId: true,
                status: true,
              },
            },
          },
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

    type RosterShift = (typeof shifts)[number];
    type RosterParticipant = RosterShift['assignments'][number]['participant'];

    const persona = (participant: RosterParticipant, capitan: string | null): RosterPerson => ({
      name: rosterName(participant),
      phone: formatNationalPhone(participant.phoneE164),
      isCaptain: participant.id === capitan,
    });
    const porNombre = (a: RosterParticipant, b: RosterParticipant) =>
      rosterName(a).localeCompare(rosterName(b), 'es');
    /** Por nombre, con el capitán y su cónyuge al frente. */
    const ordenar = (gente: RosterParticipant[], capitan: string | null): RosterPerson[] =>
      captainFirst(
        [...gente].sort(porNombre),
        capitan,
        (participant) => participant.id,
        (participant) => participant.spouseId,
      ).map((participant) => persona(participant, capitan));
    const range = (shift: RosterShift) =>
      this.time.formatRangeShort(shift.startMinute, shift.endMinute);
    const weekdayOf = (shift: RosterShift) => this.time.weekday(shift.date, 'utc');

    // --- Entre semana -------------------------------------------------------
    // Titular es quien tiene el turno fijo en la mayoría de las fechas, haya
    // cancelado alguna o no: una baja aislada no lo saca del rol del mes.
    // Quien se dio de baja del todo sí sale: ya no va a ir a ninguna.
    const porFranja = new Map<string, RosterShift[]>();
    for (const shift of shifts) {
      const dia = weekdayOf(shift);
      if (dia === 0 || dia === 6) continue;
      const clave = `${dia}:${shift.startMinute}`;
      porFranja.set(clave, [...(porFranja.get(clave) ?? []), shift]);
    }

    const weekdays: RosterDay[] = [];
    for (const dia of [1, 2, 3, 4, 5] as const) {
      const slots: RosterSlot[] = [];
      for (const grupo of porFranja.values()) {
        const muestra = grupo[0];
        if (weekdayOf(muestra) !== dia) continue;

        const fijos = new Map<string, { participant: RosterParticipant; veces: number }>();
        for (const shift of grupo) {
          for (const assignment of shift.assignments) {
            if (assignment.origin !== AssignmentOrigin.FIXED) continue;
            if (assignment.participant.status === ParticipantStatus.INACTIVE) continue;
            const previo = fijos.get(assignment.participantId);
            fijos.set(assignment.participantId, {
              participant: assignment.participant,
              veces: (previo?.veces ?? 0) + 1,
            });
          }
        }
        const titulares = [...fijos.values()].filter((fijo) => fijo.veces * 2 > grupo.length);
        const capacidad = Math.max(...grupo.map((shift) => shift.capacity));

        slots.push({
          startMinute: muestra.startMinute,
          range: range(muestra),
          people: ordenar(
            titulares.map((fijo) => fijo.participant),
            captainOf(muestra),
          ),
          missing: Math.max(0, capacidad - titulares.length),
        });
      }
      if (slots.length === 0) continue;
      weekdays.push({
        title: DIAS_DEL_ROL[dia],
        subtitle: null,
        slots: slots.sort((a, b) => a.startMinute - b.startMinute),
      });
    }

    // --- Fines de semana ----------------------------------------------------
    const porFecha = new Map<string, RosterShift[]>();
    for (const shift of shifts) {
      const dia = weekdayOf(shift);
      if (dia !== 0 && dia !== 6) continue;
      if (shift.status === ShiftStatus.CANCELLED) continue;
      const fecha = shift.date.toISOString().slice(0, 10);
      porFecha.set(fecha, [...(porFecha.get(fecha) ?? []), shift]);
    }

    const fechas = [...porFecha.values()].map((grupo) => {
      const local = this.time.toLocalDate(grupo[0].date, location.timezone).setLocale('es-MX');
      const dia = weekdayOf(grupo[0]);
      return { grupo, local, dia, ordinal: this.time.ordinalOfMonth(local) };
    });
    // Como se organizan los turnos fijos: por ordinal, y el sábado antes que el
    // domingo de ese mismo ordinal aunque en el calendario caiga después.
    fechas.sort((a, b) => a.ordinal - b.ordinal || (a.dia === 6 ? -1 : 1) - (b.dia === 6 ? -1 : 1));

    const weekends: RosterDay[] = fechas.map(({ grupo, local, dia, ordinal }) => ({
      title: `${ORDINALES_DEL_ROL[ordinal]} ${dia === 6 ? 'sábado' : 'domingo'}`,
      subtitle: local.toFormat("d 'de' LLLL 'de' yyyy"),
      slots: grupo.map((shift) => {
        const presentes = shift.assignments.filter((assignment) =>
          OCCUPYING_STATUSES.includes(assignment.status),
        );
        return {
          startMinute: shift.startMinute,
          range: range(shift),
          people: ordenar(
            presentes.map((assignment) => assignment.participant),
            captainOf(shift),
          ),
          missing: Math.max(0, shift.capacity - presentes.length),
        };
      }),
    }));

    return {
      locationName: location.name,
      year,
      month,
      monthLabel: start.setLocale('es-MX').toFormat('LLLL yyyy'),
      weekdays,
      weekends,
    };
  }
}
