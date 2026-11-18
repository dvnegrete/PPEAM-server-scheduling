import { Injectable, Logger } from '@nestjs/common';
import {
  AssignmentOrigin,
  AssignmentStatus,
  Location,
  ParticipantStatus,
  Prisma,
  ShiftStatus,
} from '@prisma/client';
import { DateTime } from 'luxon';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { TimeService, Weekday } from '../common/time/time.service';
import { PrismaService } from '../prisma/prisma.service';
import { canBeFilled, holdersToSeat, isHolderOn, SyncAssignment, SyncShift } from './holder-sync';
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

/** Lo que hace falta saber de un turno ya existente para decidir si se rellena. */
interface ShiftSnapshot {
  id: string;
  capacity: number;
  status: ShiftStatus;
  startsAt: Date;
  assignments: Array<{ participantId: string; status: AssignmentStatus }>;
}

/** Los titulares de una plantilla, con la vigencia de cada uno. */
interface TemplateHolders {
  capacity: number;
  recurringAssignments: Array<{
    participantId: string;
    startsOn: Date | null;
    endsOn: Date | null;
  }>;
}

/** Un turno se identifica dentro de su punto por la fecha y la hora de inicio. */
function snapshotKey(date: Date, startMinute: number): string {
  return `${date.toISOString()}|${startMinute}`;
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

    const snapshots = await this.loadMonthSnapshots(locationId, year, month);

    for (const template of templates) {
      const dates = this.time.occurrencesInMonth(
        year,
        month,
        template.weekday as Weekday,
        template.weekOfMonth,
        location.timezone,
      );

      for (const date of dates) {
        const created = await this.materializeShift(location, template, date, result, snapshots);
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

  /**
   * Los turnos que el mes ya tiene, con quién figura en cada uno.
   *
   * Se leen de una vez porque lo normal es que el mes ya esté generado y no
   * haya nada que hacer: preguntar turno por turno eran dos consultas por cada
   * fecha de cada plantilla, todas las noches y por cada mes del horizonte.
   */
  private async loadMonthSnapshots(
    locationId: string,
    year: number,
    month: number,
  ): Promise<Map<string, ShiftSnapshot>> {
    const firstDay = DateTime.utc(year, month, 1);
    const shifts = await this.prisma.shift.findMany({
      where: {
        locationId,
        date: {
          gte: this.time.toDateColumn(firstDay),
          lte: this.time.toDateColumn(firstDay.endOf('month')),
        },
      },
      select: {
        id: true,
        date: true,
        startMinute: true,
        capacity: true,
        status: true,
        startsAt: true,
        assignments: { select: { participantId: true, status: true } },
      },
    });

    return new Map(shifts.map((shift) => [snapshotKey(shift.date, shift.startMinute), shift]));
  }

  private async materializeShift(
    location: Location,
    template: TemplateHolders & {
      id: string;
      weekday: number;
      startMinute: number;
      endMinute: number;
      weekOfMonth: number;
    },
    date: DateTime,
    result: GenerationResult,
    snapshots: Map<string, ShiftSnapshot>,
  ): Promise<boolean> {
    const dateColumn = this.time.toDateColumn(date);
    const key = snapshotKey(dateColumn, template.startMinute);

    const existing = snapshots.get(key);
    if (existing) {
      await this.fillExisting(existing, template, dateColumn, result);
      return false;
    }

    const eligible = template.recurringAssignments.filter((recurring) =>
      isHolderOn(recurring, dateColumn),
    );
    const seated = eligible.slice(0, template.capacity);
    const status = eligible.length >= template.capacity ? ShiftStatus.FULL : ShiftStatus.OPEN;

    let shift: { id: string; capacity: number; startsAt: Date };
    try {
      shift = await this.prisma.shift.create({
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
          status,
        },
      });
    } catch (error) {
      // Otra generación lo creó después de leer el mes (el cron y el botón del
      // panel pueden coincidir). Se trata como lo que ya es: un turno existente.
      if (!isUniqueViolation(error)) throw error;
      const concurrent = await this.prisma.shift.findUniqueOrThrow({
        where: {
          locationId_date_startMinute: {
            locationId: location.id,
            date: dateColumn,
            startMinute: template.startMinute,
          },
        },
      });
      await this.seatMissingHolders(concurrent, template, dateColumn, result);
      return false;
    }

    if (eligible.length > template.capacity) {
      result.overbookedTemplates.push(template.id);
      this.logger.warn(
        `La plantilla ${template.id} tiene ${eligible.length} titulares fijos para ${template.capacity} lugares; ` +
          `se sientan los primeros ${template.capacity} por antigüedad`,
      );
    }

    if (seated.length > 0) {
      await this.prisma.assignment.createMany({
        data: seated.map((recurring) => ({
          shiftId: shift.id,
          participantId: recurring.participantId,
          origin: AssignmentOrigin.FIXED,
          status: AssignmentStatus.ASSIGNED,
        })),
      });
      result.assignmentsCreated += seated.length;
    }

    // Queda anotado por si otra plantilla cae en la misma fecha y hora.
    snapshots.set(key, {
      id: shift.id,
      capacity: shift.capacity,
      status,
      startsAt: shift.startsAt,
      assignments: seated.map((recurring) => ({
        participantId: recurring.participantId,
        status: AssignmentStatus.ASSIGNED,
      })),
    });

    return true;
  }

  /**
   * Rellena un turno que ya existía, si le falta algún titular.
   *
   * Lo leído al empezar solo sirve para descartar: si según eso no falta nadie,
   * no se consulta nada más. Si falta, se decide de nuevo con datos frescos,
   * porque entre una lectura y otra alguien pudo cancelar o tomar el lugar.
   */
  private async fillExisting(
    snapshot: ShiftSnapshot,
    template: TemplateHolders,
    dateColumn: Date,
    result: GenerationResult,
  ): Promise<void> {
    if (this.missingHolders(snapshot, snapshot.assignments, template, dateColumn).length === 0) {
      return;
    }

    const seated = await this.seatMissingHolders(snapshot, template, dateColumn, result);
    for (const participantId of seated) {
      snapshot.assignments.push({ participantId, status: AssignmentStatus.ASSIGNED });
    }
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
   *
   * Devuelve a quiénes sentó.
   */
  private async seatMissingHolders(
    shift: { id: string; capacity: number; status: ShiftStatus; startsAt: Date },
    template: TemplateHolders,
    dateColumn: Date,
    result: GenerationResult,
  ): Promise<string[]> {
    if (!canBeFilled(shift, this.time.now())) return [];

    const asignaciones = await this.prisma.assignment.findMany({
      where: { shiftId: shift.id },
      select: { participantId: true, status: true },
    });

    const faltantes = this.missingHolders(shift, asignaciones, template, dateColumn);
    if (faltantes.length === 0) return [];

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

    const ocupantes = asignaciones.filter((a) => OCCUPYING_STATUSES.includes(a.status));
    if (ocupantes.length + faltantes.length >= shift.capacity) {
      await this.prisma.shift.update({
        where: { id: shift.id },
        data: { status: ShiftStatus.FULL },
      });
    }

    return faltantes.map((recurring) => recurring.participantId);
  }

  private missingHolders(
    shift: SyncShift,
    assignments: SyncAssignment[],
    template: TemplateHolders,
    dateColumn: Date,
  ): TemplateHolders['recurringAssignments'] {
    return holdersToSeat(
      shift,
      assignments,
      template.recurringAssignments,
      dateColumn,
      this.time.now(),
    );
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
