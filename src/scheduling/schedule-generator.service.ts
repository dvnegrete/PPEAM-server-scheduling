import { Injectable, Logger } from '@nestjs/common';
import {
  ActorType,
  AssignmentOrigin,
  AssignmentStatus,
  Location,
  ParticipantStatus,
  Prisma,
  ShiftStatus,
} from '@prisma/client';
import { DateTime } from 'luxon';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { fullName, PersonName } from '../common/names/person-name';
import { TimeService, Weekday } from '../common/time/time.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  canBeFilled,
  formerHolders,
  holdersToSeat,
  isHolderOn,
  pendingHolders,
  SyncAssignment,
  SyncHolder,
  SyncShift,
} from './holder-sync';
import type { Actor } from './recurring-assignments.service';
import { OCCUPYING_STATUSES, ShiftsService } from './shifts.service';

export interface GenerationResult {
  shiftsCreated: number;
  shiftsExisting: number;
  /** Turnos que ya existían y a los que se sentó algún titular que faltaba. */
  shiftsFilled: number;
  assignmentsCreated: number;
  /** Plantillas donde había más titulares fijos que lugares disponibles. */
  overbookedTemplates: string[];
  /**
   * Fechas de las que se retiró a quien ya no es titular de ese turno fijo.
   * Solo ocurre en los meses posteriores al actual.
   */
  formerHoldersReleased: number;
  /** Titulares vigentes que no se sentaron porque el turno ya estaba lleno. */
  holdersNotSeated: number;
}

/** Lo que haría `generateMonth` en un mes ya generado, sin escribir nada. */
export interface MonthPreview {
  /** Fechas de las que se retiraría a quien ya no es titular. */
  toRelease: number;
  /** Titulares que se sentarían en fechas donde aún no figuran. */
  toSeat: number;
  /** Titulares que no cabrían porque el turno ya está lleno. */
  notSeated: number;
  /** Turnos de franjas agregadas después de generar el mes. */
  shiftsToCreate: number;
}

/** Lo que hace falta saber de un turno ya existente para decidir si se rellena. */
interface ShiftSnapshot {
  id: string;
  capacity: number;
  status: ShiftStatus;
  startsAt: Date;
  assignments: Array<{ participantId: string; status: AssignmentStatus }>;
}

/** Un turno tal como se leyó del mes, con lo necesario para retirar a alguien. */
interface LoadedShift extends ShiftSnapshot {
  date: Date;
  startMinute: number;
  endMinute: number;
  assignments: Array<{
    id: string;
    participantId: string;
    status: AssignmentStatus;
    origin: AssignmentOrigin;
    participant: PersonName;
  }>;
}

/** Una plantilla con todos sus titulares activos, estén o no en pausa. */
interface TemplateWithHolders extends TemplateHolders {
  weekday: number;
  weekOfMonth: number;
  startMinute: number;
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
 * Es idempotente y conservador con lo que ya existe, porque para entonces un
 * turno puede tener cancelaciones y coberturas encima:
 * - En el mes en curso y en los pasados solo añade: sienta a los titulares que
 *   falten, sin quitar a nadie.
 * - En los meses posteriores al actual, además, retira a quien ocupaba una
 *   fecha solo porque era titular y ya no lo es. Así el rol del mes próximo
 *   refleja los cambios de turnos fijos sin perder cancelaciones ni coberturas.
 */
@Injectable()
export class ScheduleGeneratorService {
  private readonly logger = new Logger(ScheduleGeneratorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly time: TimeService,
    private readonly audit: AuditService,
    private readonly shifts: ShiftsService,
  ) {}

  /**
   * Genera o completa un mes.
   *
   * `actor` es quien lo pidió desde el panel; queda en la bitácora de cada fecha
   * de la que se retire a alguien.
   */
  async generateMonth(
    locationId: string,
    year: number,
    month: number,
    actor: Actor = {},
  ): Promise<GenerationResult> {
    const location = await this.prisma.location.findUniqueOrThrow({ where: { id: locationId } });
    const { allTemplates, templates } = await this.loadTemplates(locationId);

    const result: GenerationResult = {
      shiftsCreated: 0,
      shiftsExisting: 0,
      shiftsFilled: 0,
      assignmentsCreated: 0,
      overbookedTemplates: [],
      formerHoldersReleased: 0,
      holdersNotSeated: 0,
    };

    const snapshots = await this.loadMonthSnapshots(locationId, year, month);

    if (this.isAfterCurrentMonth(year, month, location.timezone)) {
      // Antes de sentar: el lugar que deja el titular anterior es el que ocupa
      // el nuevo. Para decidir quién sigue siendo titular cuenta también quien
      // está en pausa, para no quitarle su lugar.
      await this.releaseFormerHolders(
        location,
        allTemplates,
        year,
        month,
        snapshots,
        result,
        actor,
      );
    }

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
        `(${result.shiftsFilled} completado(s)), ${result.assignmentsCreated} asignación(es) fija(s), ` +
        `${result.formerHoldersReleased} retirada(s) por ya no ser titular, ` +
        `${result.holdersNotSeated} titular(es) sin lugar`,
    );

    await this.audit.recordSystem(AUDIT_ACTIONS.SHIFT_GENERATED, 'Location', locationId, {
      year,
      month,
      ...result,
    });

    return result;
  }

  /**
   * Lo que cambiaría al volver a generar un mes ya generado, sin escribir nada.
   *
   * Aplica las mismas reglas que `generateMonth` (`holder-sync.ts`) sobre los
   * mismos datos, para que el aviso del panel no prometa algo distinto de lo que
   * después se hace.
   */
  async previewMonth(locationId: string, year: number, month: number): Promise<MonthPreview> {
    const location = await this.prisma.location.findUniqueOrThrow({ where: { id: locationId } });
    const { allTemplates, templates } = await this.loadTemplates(locationId);
    const snapshots = await this.loadMonthSnapshots(locationId, year, month);
    const releases = this.isAfterCurrentMonth(year, month, location.timezone);
    const currentByKey = this.holdersByKey(allTemplates, year, month, location.timezone);
    const seatableByKey = this.holdersByKey(templates, year, month, location.timezone);
    const now = this.time.now();

    const preview: MonthPreview = { toRelease: 0, toSeat: 0, notSeated: 0, shiftsToCreate: 0 };

    for (const [key, holders] of currentByKey) {
      const snapshot = snapshots.get(key);
      if (!snapshot) {
        preview.shiftsToCreate += 1;
        continue;
      }

      const current = new Set(holders.map((holder) => holder.participantId));
      const released = releases ? formerHolders(snapshot, snapshot.assignments, current, now) : [];
      const remaining = snapshot.assignments.filter((assignment) => !released.includes(assignment));
      const seatable = seatableByKey.get(key) ?? [];
      const pending = pendingHolders(snapshot, remaining, seatable, snapshot.date, now);
      const seated = holdersToSeat(snapshot, remaining, seatable, snapshot.date, now);

      preview.toRelease += released.length;
      preview.toSeat += seated.length;
      preview.notSeated += pending.length - seated.length;
    }

    return preview;
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
  ): Promise<Map<string, LoadedShift>> {
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
        endMinute: true,
        capacity: true,
        status: true,
        startsAt: true,
        assignments: {
          select: {
            id: true,
            participantId: true,
            status: true,
            origin: true,
            participant: {
              select: { firstName: true, paternalSurname: true, maternalSurname: true },
            },
          },
        },
      },
    });

    return new Map(shifts.map((shift) => [snapshotKey(shift.date, shift.startMinute), shift]));
  }

  /**
   * Las plantillas activas con sus titulares.
   *
   * `allTemplates` incluye a todos los titulares, para saber quién sigue
   * siéndolo. `templates` deja solo a los activos, que son los que se sientan:
   * quien está pausado o dado de baja no se sienta, aunque siga siendo titular
   * de la franja. Su turno fijo se conserva a propósito: cuando vuelva a estar
   * activo recupera su lugar sin tener que recapturarlo, y mientras tanto el
   * hueco queda visible para cubrirlo.
   */
  private async loadTemplates(locationId: string) {
    const allTemplates = await this.prisma.shiftTemplate.findMany({
      where: { locationId, active: true },
      include: {
        recurringAssignments: {
          where: { active: true },
          include: { participant: { select: { status: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    const templates = allTemplates.map((template) => ({
      ...template,
      recurringAssignments: template.recurringAssignments.filter(
        (recurring) => recurring.participant.status === ParticipantStatus.ACTIVE,
      ),
    }));
    return { allTemplates, templates };
  }

  /** Si el mes pedido es posterior al mes en curso del punto. */
  private isAfterCurrentMonth(year: number, month: number, timezone: string): boolean {
    const now = this.time.nowInZone(timezone);
    return year * 12 + month > now.year * 12 + now.month;
  }

  /**
   * Quita de cada fecha a quien la ocupaba solo por ser titular y ya no lo es.
   *
   * Lo que se retira lo decide `formerHolders`: nunca una cancelación, una
   * cobertura ni un alta manual. Se borra la fila —no se marca como cancelada—
   * para que no cuente como cancelación en los reportes; el rastro queda en la
   * bitácora, que es de donde sale el historial de cada turno.
   *
   * Solo se revisan las fechas que alguna plantilla activa sigue produciendo: un
   * turno de una franja que se dio de baja no tiene «titulares actuales» con
   * qué comparar, y vaciarlo sería peor que dejarlo como está.
   */
  private async releaseFormerHolders(
    location: Location,
    templates: TemplateWithHolders[],
    year: number,
    month: number,
    snapshots: Map<string, LoadedShift>,
    result: GenerationResult,
    actor: Actor,
  ): Promise<void> {
    const holdersByKey = this.holdersByKey(templates, year, month, location.timezone);
    const now = this.time.now();

    for (const [key, snapshot] of snapshots) {
      const holders = holdersByKey.get(key);
      if (!holders) continue;
      const currentHolders = new Set(holders.map((holder) => holder.participantId));

      const candidates = formerHolders(snapshot, snapshot.assignments, currentHolders, now);
      if (candidates.length === 0) continue;

      const shiftLabel = this.shifts.label(snapshot, location.timezone);
      const { released, status } = await this.prisma.$transaction(async (tx) => {
        // Se vuelve a leer dentro de la transacción: entre la lectura del mes y
        // ahora alguien pudo cancelar, y una cancelación ya no se toca.
        const fresh = await tx.assignment.findMany({
          where: {
            id: { in: candidates.map((assignment) => assignment.id) },
            origin: AssignmentOrigin.FIXED,
            status: { in: OCCUPYING_STATUSES },
          },
          select: { id: true, status: true },
        });
        if (fresh.length > 0) {
          await tx.assignment.deleteMany({
            where: { id: { in: fresh.map((assignment) => assignment.id) } },
          });
        }

        for (const row of fresh) {
          const assignment = candidates.find((candidate) => candidate.id === row.id)!;
          await this.audit.record(
            {
              actorType: actor.id ? ActorType.ADMIN : ActorType.SYSTEM,
              actorId: actor.id ?? null,
              actorName: actor.name ?? null,
              action: AUDIT_ACTIONS.ASSIGNMENT_RELEASED,
              entity: 'Assignment',
              entityId: row.id,
              before: { status: row.status, origin: AssignmentOrigin.FIXED },
              metadata: {
                shiftId: snapshot.id,
                shiftLabel,
                participantId: assignment.participantId,
                participantName: fullName(assignment.participant),
                reason: 'recurring_removed',
              },
            },
            tx,
          );
        }

        const status = await this.shifts.recomputeStatus(snapshot.id, tx);
        return { released: new Set(fresh.map((assignment) => assignment.id)), status };
      });

      snapshot.assignments = snapshot.assignments.filter(
        (assignment) => !released.has(assignment.id),
      );
      snapshot.status = status;
      result.formerHoldersReleased += released.size;
    }
  }

  /**
   * Los titulares vigentes de cada fecha y hora del mes, juntando todas las
   * plantillas que caen ahí, por antigüedad y sin repetir a nadie.
   */
  private holdersByKey<T extends SyncHolder>(
    templates: Array<{
      weekday: number;
      weekOfMonth: number;
      startMinute: number;
      recurringAssignments: T[];
    }>,
    year: number,
    month: number,
    timezone: string,
  ): Map<string, T[]> {
    const holdersByKey = new Map<string, T[]>();
    for (const template of templates) {
      const dates = this.time.occurrencesInMonth(
        year,
        month,
        template.weekday as Weekday,
        template.weekOfMonth,
        timezone,
      );
      for (const date of dates) {
        const dateColumn = this.time.toDateColumn(date);
        const key = snapshotKey(dateColumn, template.startMinute);
        const holders = holdersByKey.get(key) ?? [];
        for (const recurring of template.recurringAssignments) {
          const listed = holders.some((holder) => holder.participantId === recurring.participantId);
          if (!listed && isHolderOn(recurring, dateColumn)) holders.push(recurring);
        }
        holdersByKey.set(key, holders);
      }
    }
    return holdersByKey;
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
    const pending = pendingHolders(
      snapshot,
      snapshot.assignments,
      template.recurringAssignments,
      dateColumn,
      this.time.now(),
    );
    if (pending.length === 0) return;

    const seated =
      this.missingHolders(snapshot, snapshot.assignments, template, dateColumn).length === 0
        ? []
        : await this.seatMissingHolders(snapshot, template, dateColumn, result);
    result.holdersNotSeated += Math.max(0, pending.length - seated.length);
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
