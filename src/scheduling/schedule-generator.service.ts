import { Injectable, Logger } from '@nestjs/common';
import {
  AssignmentOrigin,
  AssignmentStatus,
  Location,
  ParticipantStatus,
  ShiftStatus,
} from '@prisma/client';
import { DateTime } from 'luxon';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { TimeService, Weekday } from '../common/time/time.service';
import { PrismaService } from '../prisma/prisma.service';
import { OCCUPYING_STATUSES } from './shifts.service';

export interface GenerationResult {
  shiftsCreated: number;
  shiftsExisting: number;
  /** Turnos que ya existían y a los que se sentó algún titular que faltaba. */
  shiftsFilled: number;
  assignmentsCreated: number;
  /** Plantillas donde había más titulares fijos que lugares disponibles. */
  overbookedTemplates: string[];
}

/**
 * Materializa el calendario: convierte las reglas de recurrencia en turnos
 * concretos y sienta a sus titulares fijos.
 *
 * Es idempotente y conservador: si un turno ya existe no se toca, porque para
 * entonces puede tener cancelaciones y coberturas encima. Un cambio en la
 * plantilla se refleja en los meses que aún no se han generado.
 */
@Injectable()
export class ScheduleGeneratorService {
  private readonly logger = new Logger(ScheduleGeneratorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly time: TimeService,
    private readonly audit: AuditService,
  ) {}

  async generateMonth(locationId: string, year: number, month: number): Promise<GenerationResult> {
    const location = await this.prisma.location.findUniqueOrThrow({ where: { id: locationId } });
    const templates = await this.prisma.shiftTemplate.findMany({
      where: { locationId, active: true },
      include: {
        recurringAssignments: {
          // Quien está pausado o dado de baja no se sienta, aunque siga siendo
          // titular de la franja. Su turno fijo se conserva a propósito: cuando
          // vuelva a estar activo recupera su lugar sin tener que recapturarlo,
          // y mientras tanto el hueco queda visible para cubrirlo.
          where: { active: true, participant: { status: ParticipantStatus.ACTIVE } },
          include: { participant: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    const result: GenerationResult = {
      shiftsCreated: 0,
      shiftsExisting: 0,
      shiftsFilled: 0,
      assignmentsCreated: 0,
      overbookedTemplates: [],
    };

    for (const template of templates) {
      const dates = this.time.occurrencesInMonth(
        year,
        month,
        template.weekday as Weekday,
        template.weekOfMonth,
        location.timezone,
      );

      for (const date of dates) {
        const created = await this.materializeShift(location, template, date, result);
        if (created) result.shiftsCreated += 1;
        else result.shiftsExisting += 1;
      }
    }

    this.logger.log(
      `Calendario ${year}-${String(month).padStart(2, '0')} de ${location.name}: ` +
        `${result.shiftsCreated} turno(s) nuevo(s), ${result.shiftsExisting} ya existente(s) ` +
        `(${result.shiftsFilled} completado(s)), ${result.assignmentsCreated} asignación(es) fija(s)`,
    );

    await this.audit.recordSystem(AUDIT_ACTIONS.SHIFT_GENERATED, 'Location', locationId, {
      year,
      month,
      ...result,
    });

    return result;
  }

  /** Genera los meses que faltan hasta cubrir el horizonte configurado. */
  async generateHorizon(locationId: string, months: number): Promise<GenerationResult[]> {
    const location = await this.prisma.location.findUniqueOrThrow({ where: { id: locationId } });
    const start = this.time.nowInZone(location.timezone).startOf('month');

    const results: GenerationResult[] = [];
    for (let offset = 0; offset < months; offset += 1) {
      const target = start.plus({ months: offset });
      results.push(await this.generateMonth(locationId, target.year, target.month));
    }
    return results;
  }

  private async materializeShift(
    location: Location,
    template: {
      id: string;
      weekday: number;
      startMinute: number;
      endMinute: number;
      capacity: number;
      weekOfMonth: number;
      recurringAssignments: Array<{
        participantId: string;
        startsOn: Date | null;
        endsOn: Date | null;
      }>;
    },
    date: DateTime,
    result: GenerationResult,
  ): Promise<boolean> {
    const dateColumn = this.time.toDateColumn(date);

    const existing = await this.prisma.shift.findUnique({
      where: {
        locationId_date_startMinute: {
          locationId: location.id,
          date: dateColumn,
          startMinute: template.startMinute,
        },
      },
    });
    if (existing) {
      await this.seatMissingHolders(existing, template, dateColumn, result);
      return false;
    }

    const shift = await this.prisma.shift.create({
      data: {
        locationId: location.id,
        templateId: template.id,
        date: dateColumn,
        startMinute: template.startMinute,
        endMinute: template.endMinute,
        startsAt: this.time.toInstant(date, template.startMinute, location.timezone),
        endsAt: this.time.toInstant(date, template.endMinute, location.timezone),
        capacity: template.capacity,
        // El ordinal real de esta fecha; la plantilla puede ser comodín (0).
        weekOfMonth: this.time.ordinalOfMonth(date),
        status: ShiftStatus.OPEN,
      },
    });

    const eligible = template.recurringAssignments.filter((recurring) =>
      this.isActiveOn(recurring, dateColumn),
    );

    if (eligible.length > template.capacity) {
      result.overbookedTemplates.push(template.id);
      this.logger.warn(
        `La plantilla ${template.id} tiene ${eligible.length} titulares fijos para ${template.capacity} lugares; ` +
          `se sientan los primeros ${template.capacity} por antigüedad`,
      );
    }

    for (const recurring of eligible.slice(0, template.capacity)) {
      await this.prisma.assignment.create({
        data: {
          shiftId: shift.id,
          participantId: recurring.participantId,
          origin: AssignmentOrigin.FIXED,
          status: AssignmentStatus.ASSIGNED,
        },
      });
      result.assignmentsCreated += 1;
    }

    if (eligible.length >= template.capacity) {
      await this.prisma.shift.update({
        where: { id: shift.id },
        data: { status: ShiftStatus.FULL },
      });
    }

    return true;
  }

  /**
   * Sienta en un turno que ya existe a los titulares que faltan.
   *
   * Sin esto, importar o capturar turnos fijos no servía de nada para los meses
   * ya materializados: el generador abandonaba cada turno existente y los
   * titulares nuevos solo aparecían en los meses que se crearan después. Es lo
   * que dejaba el tablero vacío justo en el mes en curso.
   *
   * Es un relleno, no una reescritura. No toca a quien ya está sentado, respeta
   * el cupo, y sobre todo **no resucita una baja**: si alguien canceló ese día,
   * esa decisión vale más que la regla, y volver a sentarlo haría que el turno
   * pareciera cubierto cuando no lo está.
   */
  private async seatMissingHolders(
    shift: { id: string; capacity: number; status: ShiftStatus; startsAt: Date },
    template: {
      capacity: number;
      recurringAssignments: Array<{
        participantId: string;
        startsOn: Date | null;
        endsOn: Date | null;
      }>;
    },
    dateColumn: Date,
    result: GenerationResult,
  ): Promise<void> {
    // Un turno cancelado no se repuebla, y el pasado no se reescribe: sentar a
    // alguien en un turno que ya ocurrió falsearía el historial de asistencia.
    if (shift.status === ShiftStatus.CANCELLED) return;
    if (shift.startsAt < this.time.now()) return;

    const asignaciones = await this.prisma.assignment.findMany({
      where: { shiftId: shift.id },
      select: { participantId: true, status: true },
    });

    const ocupantes = asignaciones.filter((a) => OCCUPYING_STATUSES.includes(a.status));
    const libres = shift.capacity - ocupantes.length;
    if (libres <= 0) return;

    // Quien ya figura en el turno —sentado o con una baja— no se vuelve a tocar.
    const yaFigura = new Set(asignaciones.map((a) => a.participantId));

    const faltantes = template.recurringAssignments
      .filter((recurring) => this.isActiveOn(recurring, dateColumn))
      .filter((recurring) => !yaFigura.has(recurring.participantId))
      .slice(0, libres);

    if (faltantes.length === 0) return;

    await this.prisma.assignment.createMany({
      data: faltantes.map((recurring) => ({
        shiftId: shift.id,
        participantId: recurring.participantId,
        origin: AssignmentOrigin.FIXED,
        status: AssignmentStatus.ASSIGNED,
      })),
      skipDuplicates: true,
    });

    result.assignmentsCreated += faltantes.length;
    result.shiftsFilled += 1;

    if (ocupantes.length + faltantes.length >= shift.capacity) {
      await this.prisma.shift.update({
        where: { id: shift.id },
        data: { status: ShiftStatus.FULL },
      });
    }
  }

  /** Respeta las vigencias de la asignación fija (altas y bajas a mitad de año). */
  private isActiveOn(
    recurring: { startsOn: Date | null; endsOn: Date | null },
    date: Date,
  ): boolean {
    if (recurring.startsOn && date < recurring.startsOn) return false;
    if (recurring.endsOn && date > recurring.endsOn) return false;
    return true;
  }
}
