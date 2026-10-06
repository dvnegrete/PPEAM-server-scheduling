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

export interface GenerationResult {
  shiftsCreated: number;
  shiftsExisting: number;
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
        `${result.shiftsCreated} turno(s) nuevo(s), ${result.shiftsExisting} ya existente(s), ` +
        `${result.assignmentsCreated} asignación(es) fija(s)`,
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
    if (existing) return false;

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
