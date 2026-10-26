import { BadRequestException, Injectable } from '@nestjs/common';
import {
  AssignmentOrigin,
  AssignmentStatus,
  CoverageRequestStatus,
  Prisma,
  ShiftStatus,
} from '@prisma/client';
import {
  ACCIONES_SENSIBLES,
  AUDIT_CATEGORIES,
  type AuditCategoryId,
  categoriaDe,
  etiquetaDe,
} from '../audit/audit-catalog';
import { displayName, formalName, PADRON_ORDER } from '../common/names/person-name';
import { TimeService } from '../common/time/time.service';
import { PrismaService } from '../prisma/prisma.service';
import { OCCUPYING_STATUSES } from '../scheduling/shifts.service';

export interface AttendanceRow {
  participantId: string;
  /** Nombre formal, como se lee en un padrón: «López Pérez, Ana María». */
  fullName: string;
  /** Turnos que efectivamente atendió (ya ocurrieron y no los canceló). */
  served: number;
  /** Turnos que canceló. */
  cancelled: number;
  /** Veces que entró a cubrir a alguien más. */
  covered: number;
  /** Turnos futuros que tiene asignados. */
  upcoming: number;
}

export interface MonthlySummary {
  year: number;
  month: number;
  locationName: string;
  totalShifts: number;
  cancelledShifts: number;
  fullyStaffedShifts: number;
  understaffedShifts: number;
  totalAssignments: number;
  cancellations: number;
  coverages: number;
  coverageRequests: number;
  coverageRequestsFulfilled: number;
  coverageRequestsExpired: number;
}

/** Nivel de necesidad de un turno; define el color con que se pinta en el tablero. */
export type NeedLevel = 'ok' | 'bajoCupo' | 'bajoMinimo' | 'cancelado';

/** Acciones que cuentan como «movimiento» en la actividad reciente. */
export const MOVEMENT_ACTIONS = [
  'assignment.cancelled',
  'assignment.created',
  'assignment.confirmed',
  'coverage.approved',
  'coverage.auto_approved',
  'shift.cancelled',
  'shift.kept',
] as const;

export interface Movement {
  id: string;
  action: string;
  /** Frase lista para mostrarse, ya redactada en español. */
  description: string;
  participantName: string | null;
  shiftLabel: string | null;
  reason: string | null;
  reasonCode: string | null;
  /** Quién lo registró. */
  by: string;
  at: string;
}

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

/** Una fila de la bitácora, ya resuelta para mostrarse. */
export interface AuditHistoryEntry {
  id: string;
  at: string;
  action: string;
  /** Nombre de la acción, del catálogo. */
  label: string;
  category: AuditCategoryId | null;
  /** Quién la hizo: «el sistema», o el nombre del actor. */
  by: string;
  actorType: string;
  /**
   * Frase contextual para las acciones que la tienen —las de turnos—; para el
   * resto es la etiqueta. Nunca una clave técnica.
   */
  description: string;
  participantName: string | null;
  shiftLabel: string | null;
  reason: string | null;
}

export interface AuditHistoryPage {
  entries: AuditHistoryEntry[];
  /** Con qué seguir hacia atrás; `null` cuando ya no hay más. */
  nextCursor: string | null;
}

export interface AuditHistoryQuery {
  from?: Date;
  to?: Date;
  categoria?: AuditCategoryId;
  /** Nombre o parte del nombre de una persona, en cualquier orden. */
  persona?: string;
  cursor?: string;
  limit: number;
  /** Las entradas de accesos y cuentas solo las ve un administrador. */
  verSensibles: boolean;
}

/**
 * Consultas para el panel y para los encargados.
 * Se apoyan en la bitácora y en el estado actual: la bitácora explica el cómo,
 * las asignaciones dicen el qué.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly time: TimeService,
  ) {}

  /**
   * Bitácora completa, de lo más reciente hacia atrás y por páginas.
   *
   * Avanza por cursor y no por `skip` porque la bitácora crece mientras se
   * navega: con un desplazamiento, una entrada nueva correría todo y la página
   * siguiente repetiría o se saltaría filas.
   */
  async auditHistory(query: AuditHistoryQuery): Promise<AuditHistoryPage> {
    const condiciones: Prisma.AuditLogWhereInput[] = [];

    if (query.from || query.to) {
      condiciones.push({ createdAt: { gte: query.from, lte: query.to } });
    }
    if (query.categoria) {
      condiciones.push({ action: { in: [...AUDIT_CATEGORIES[query.categoria].actions] } });
    }
    if (!query.verSensibles) {
      condiciones.push({ NOT: { action: { in: [...ACCIONES_SENSIBLES] } } });
    }

    const cursor = parseCursor(query.cursor);
    if (cursor) {
      // El id desempata las entradas con el mismo instante, que las hay: varias
      // acciones se registran dentro de una misma transacción.
      condiciones.push({
        OR: [
          { createdAt: { lt: cursor.at } },
          { AND: [{ createdAt: cursor.at }, { id: { lt: cursor.id } }] },
        ],
      });
    }

    if (query.persona) {
      condiciones.push(await this.filtroDePersona(query.persona));
    }

    const logs = await this.prisma.auditLog.findMany({
      where: condiciones.length > 0 ? { AND: condiciones } : {},
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // Una fila de más es lo que delata que hay página siguiente, sin un count.
      take: query.limit + 1,
    });

    const hayMas = logs.length > query.limit;
    const pagina = hayMas ? logs.slice(0, query.limit) : logs;
    const ultima = pagina.at(-1);

    return {
      entries: pagina.map((log) => this.toHistoryEntry(log)),
      nextCursor: hayMas && ultima ? `${ultima.createdAt.toISOString()}|${ultima.id}` : null,
    };
  }

  /**
   * El nombre de una persona aparece en tres sitios según la acción: como actor
   * de lo que hizo, como entidad de lo que le pasó, y dentro de `metadata`
   * cuando la entidad es la asignación y no ella. Se buscan los tres.
   *
   * El texto se parte en palabras y se exigen todas, para que «López Ana»
   * encuentre lo mismo que «Ana López».
   */
  private async filtroDePersona(persona: string): Promise<Prisma.AuditLogWhereInput> {
    const palabras = persona.trim().split(/\s+/).filter(Boolean).slice(0, 5);
    if (palabras.length === 0) return {};

    const participantes = await this.prisma.participant.findMany({
      where: {
        AND: palabras.map((palabra) => ({
          OR: [
            { firstName: { contains: palabra, mode: 'insensitive' as const } },
            { paternalSurname: { contains: palabra, mode: 'insensitive' as const } },
            { maternalSurname: { contains: palabra, mode: 'insensitive' as const } },
            { displayName: { contains: palabra, mode: 'insensitive' as const } },
          ],
        })),
      },
      select: { id: true },
      take: 200,
    });

    const ramas: Prisma.AuditLogWhereInput[] = [
      {
        AND: palabras.map((palabra) => ({ actorName: { contains: palabra, mode: 'insensitive' } })),
      },
      {
        AND: palabras.map((palabra) => ({
          metadata: { path: ['participantName'], string_contains: palabra },
        })),
      },
    ];
    if (participantes.length > 0) {
      ramas.push({ entityId: { in: participantes.map((p) => p.id) } });
    }

    return { OR: ramas };
  }

  /** Reutiliza la redacción de los movimientos y le añade etiqueta y categoría. */
  private toHistoryEntry(log: {
    id: string;
    action: string;
    actorType: string;
    actorName: string | null;
    createdAt: Date;
    metadata: unknown;
    after: unknown;
  }): AuditHistoryEntry {
    const movimiento = this.toMovement(log);
    return {
      id: movimiento.id,
      at: movimiento.at,
      action: movimiento.action,
      label: etiquetaDe(log.action),
      category: categoriaDe(log.action),
      by: movimiento.by,
      actorType: log.actorType,
      description: movimiento.description,
      participantName: movimiento.participantName,
      shiftLabel: movimiento.shiftLabel,
      reason: movimiento.reason ?? movimiento.reasonCode,
    };
  }

  /** Participación de cada persona en un periodo. */
  async attendance(locationId: string, from: Date, to: Date): Promise<AttendanceRow[]> {
    const participants = await this.prisma.participant.findMany({
      where: { memberships: { some: { locationId, active: true } } },
      orderBy: [...PADRON_ORDER],
    });

    const assignments = await this.prisma.assignment.findMany({
      where: {
        shift: { locationId, startsAt: { gte: from, lte: to } },
      },
      include: { shift: { select: { startsAt: true, status: true } } },
    });

    const now = this.time.now();
    const byParticipant = new Map<string, AttendanceRow>();

    for (const participant of participants) {
      byParticipant.set(participant.id, {
        participantId: participant.id,
        fullName: formalName(participant),
        served: 0,
        cancelled: 0,
        covered: 0,
        upcoming: 0,
      });
    }

    for (const assignment of assignments) {
      const row = byParticipant.get(assignment.participantId);
      if (!row) continue;

      if (assignment.status === AssignmentStatus.CANCELLED) {
        row.cancelled += 1;
        continue;
      }
      if (assignment.shift.status === ShiftStatus.CANCELLED) continue;

      if (assignment.shift.startsAt < now) {
        row.served += 1;
        if (assignment.origin === AssignmentOrigin.COVERAGE) row.covered += 1;
      } else {
        row.upcoming += 1;
      }
    }

    return [...byParticipant.values()];
  }

  /** Resumen mensual del punto de exhibición. */
  async monthlySummary(locationId: string, year: number, month: number): Promise<MonthlySummary> {
    const location = await this.prisma.location.findUniqueOrThrow({ where: { id: locationId } });
    const from = this.time.toInstant(
      `${year}-${String(month).padStart(2, '0')}-01`,
      0,
      location.timezone,
    );
    const to = new Date(
      this.time
        .nowInZone(location.timezone)
        .set({ year, month, day: 1 })
        .startOf('month')
        .plus({ months: 1 })
        .toUTC()
        .toMillis(),
    );

    const shifts = await this.prisma.shift.findMany({
      where: { locationId, startsAt: { gte: from, lt: to } },
      include: { assignments: true },
    });

    let fullyStaffed = 0;
    let understaffed = 0;
    let cancelledShifts = 0;
    let totalAssignments = 0;
    let cancellations = 0;
    let coverages = 0;

    for (const shift of shifts) {
      if (shift.status === ShiftStatus.CANCELLED) {
        cancelledShifts += 1;
      }

      const occupying = shift.assignments.filter((assignment) =>
        OCCUPYING_STATUSES.includes(assignment.status),
      );
      totalAssignments += occupying.length;
      cancellations += shift.assignments.filter(
        (assignment) => assignment.status === AssignmentStatus.CANCELLED,
      ).length;
      coverages += occupying.filter(
        (assignment) => assignment.origin === AssignmentOrigin.COVERAGE,
      ).length;

      if (shift.status === ShiftStatus.CANCELLED) continue;
      if (occupying.length >= location.minCapacity) fullyStaffed += 1;
      else understaffed += 1;
    }

    const requests = await this.prisma.coverageRequest.groupBy({
      by: ['status'],
      where: { shift: { locationId, startsAt: { gte: from, lt: to } } },
      _count: true,
    });

    const countOf = (status: CoverageRequestStatus): number =>
      requests.find((item) => item.status === status)?._count ?? 0;

    return {
      year,
      month,
      locationName: location.name,
      totalShifts: shifts.length,
      cancelledShifts,
      fullyStaffedShifts: fullyStaffed,
      understaffedShifts: understaffed,
      totalAssignments,
      cancellations,
      coverages,
      coverageRequests: requests.reduce((sum, item) => sum + item._count, 0),
      coverageRequestsFulfilled: countOf(CoverageRequestStatus.FULFILLED),
      coverageRequestsExpired: countOf(CoverageRequestStatus.EXPIRED),
    };
  }

  /** Estado del calendario para la vista de mes del panel. */
  async monthCalendar(locationId: string, year: number, month: number) {
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
          where: { status: { in: OCCUPYING_STATUSES } },
          include: {
            participant: {
              select: {
                id: true,
                firstName: true,
                paternalSurname: true,
                maternalSurname: true,
                displayName: true,
              },
            },
          },
        },
      },
      orderBy: [{ date: 'asc' }, { startMinute: 'asc' }],
    });

    return shifts.map((shift) => ({
      id: shift.id,
      date: shift.date.toISOString().slice(0, 10),
      range: this.time.formatRange(shift.startMinute, shift.endMinute),
      startMinute: shift.startMinute,
      endMinute: shift.endMinute,
      status: shift.status,
      capacity: shift.capacity,
      occupied: shift.assignments.length,
      weekOfMonth: shift.weekOfMonth,
      participants: shift.assignments.map((assignment) => ({
        id: assignment.participant.id,
        name: displayName(assignment.participant),
        origin: assignment.origin,
        confirmed: assignment.status === AssignmentStatus.CONFIRMED,
      })),
    }));
  }

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
      },
      orderBy: [{ date: 'asc' }, { startMinute: 'asc' }],
    });

    const days = new Map<string, DashboardDay>();
    let understaffed = 0;
    let critical = 0;
    let cancellations = 0;

    for (const shift of shifts) {
      const ocupantes = shift.assignments.filter((assignment) =>
        OCCUPYING_STATUSES.includes(assignment.status),
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

  /**
   * Movimientos de un turno en orden cronológico.
   *
   * Se lee de la bitácora, no de las asignaciones, porque el índice único obliga a
   * reutilizar la fila cuando alguien cancela y otro toma su lugar: la tabla solo
   * conserva el estado vigente, mientras que aquí queda el recorrido completo,
   * incluidas las personas que ya no figuran en el turno.
   */
  async shiftHistory(shiftId: string): Promise<Movement[]> {
    const logs = await this.prisma.auditLog.findMany({
      where: {
        OR: [
          { metadata: { path: ['shiftId'], equals: shiftId } },
          { entity: 'Shift', entityId: shiftId },
        ],
        // El trasiego interno de las solicitudes a encargados no le dice nada a
        // quien mira el historial de un turno; lo que importa es quién entró y
        // quién salió.
        action: { notIn: ['task.created', 'task.claimed', 'task.escalated'] },
      },
      orderBy: { createdAt: 'asc' },
    });

    return logs.map((log) => this.toMovement(log));
  }

  /** Últimos movimientos del punto, para la tira de actividad reciente del tablero. */
  async recentMovements(locationId: string, limit = 20): Promise<Movement[]> {
    const shiftIds = await this.prisma.shift.findMany({
      where: { locationId },
      select: { id: true },
    });
    const conocidos = new Set(shiftIds.map((shift) => shift.id));

    const logs = await this.prisma.auditLog.findMany({
      where: { action: { in: [...MOVEMENT_ACTIONS] } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit * 10, 400),
    });

    return logs
      .filter((log) => {
        const shiftId = (log.metadata as { shiftId?: string } | null)?.shiftId;
        return shiftId ? conocidos.has(shiftId) : false;
      })
      .slice(0, limit)
      .map((log) => this.toMovement(log));
  }

  /** Traduce un registro de bitácora a una frase que se pueda leer de corrido. */
  private toMovement(log: {
    id: string;
    action: string;
    actorType: string;
    actorName: string | null;
    createdAt: Date;
    metadata: unknown;
    after: unknown;
  }): Movement {
    const meta = (log.metadata ?? {}) as Record<string, unknown>;
    const after = (log.after ?? {}) as Record<string, unknown>;
    const quien = typeof meta.participantName === 'string' ? meta.participantName : null;
    const turno = typeof meta.shiftLabel === 'string' ? meta.shiftLabel : null;
    const motivo = typeof after.reason === 'string' ? after.reason : null;
    const codigo = typeof after.reasonCode === 'string' ? after.reasonCode : null;

    let description: string;
    switch (log.action) {
      case 'assignment.cancelled':
        description = `${quien ?? 'Alguien'} canceló${turno ? ` ${turno}` : ''}`;
        if (codigo) description += ` · ${codigo}`;
        break;
      case 'assignment.created':
        description = `${quien ?? 'Alguien'} entró a cubrir${turno ? ` ${turno}` : ''}`;
        break;
      case 'assignment.confirmed':
        description = `${quien ?? 'Alguien'} confirmó su asistencia`;
        break;
      case 'coverage.opened':
        description = 'Quedó un lugar libre por cubrir';
        break;
      case 'coverage.broadcast':
        description = 'Se avisó de la vacante a los participantes';
        break;
      case 'coverage.offered':
        description = `${quien ?? 'Alguien'} se ofreció a cubrirlo`;
        break;
      case 'coverage.expired':
        description = 'Venció el plazo para ofrecerse';
        break;
      case 'coverage.approved':
      case 'coverage.auto_approved':
        description = `Cobertura aprobada${turno ? ` para ${turno}` : ''}`;
        break;
      case 'shift.cancelled':
        description = `Se canceló el turno${turno ? ` ${turno}` : ''}`;
        break;
      case 'shift.kept':
        description = `Se decidió mantener el turno${turno ? ` ${turno}` : ''}`;
        break;
      default:
        // Las nueve de arriba llevan frase propia porque el tablero las muestra
        // en contexto; para el resto basta el nombre de la acción, que el
        // catálogo resuelve en un solo sitio.
        description = etiquetaDe(log.action);
    }

    return {
      id: log.id,
      action: log.action,
      description,
      participantName: quien,
      shiftLabel: turno,
      reason: motivo,
      reasonCode: codigo,
      by: log.actorType === 'SYSTEM' ? 'el sistema' : (log.actorName ?? 'alguien'),
      at: log.createdAt.toISOString(),
    };
  }
}

/**
 * `<ISO>|<id>`. Un cursor ilegible se rechaza en vez de ignorarse: devolver
 * silenciosamente la primera página haría creer que ya no hay más histórico.
 */
function parseCursor(raw?: string): { at: Date; id: string } | null {
  if (!raw) return null;
  const corte = raw.indexOf('|');
  if (corte <= 0) throw new BadRequestException('El cursor no tiene el formato esperado');

  const at = new Date(raw.slice(0, corte));
  const id = raw.slice(corte + 1);
  if (Number.isNaN(at.getTime()) || id.length === 0) {
    throw new BadRequestException('El cursor no tiene el formato esperado');
  }
  return { at, id };
}
