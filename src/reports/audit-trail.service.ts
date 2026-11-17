import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ACCIONES_SENSIBLES,
  AUDIT_CATEGORIES,
  type AuditCategoryId,
  categoriaDe,
  etiquetaDe,
} from '../audit/audit-catalog';
import { PrismaService } from '../prisma/prisma.service';

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
 * Lo que se lee de la bitácora: el histórico completo y los movimientos de los
 * turnos, ya redactados para mostrarse.
 */
@Injectable()
export class AuditTrailService {
  constructor(private readonly prisma: PrismaService) {}

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
    const logs = await this.prisma.auditLog.findMany({
      where: { action: { in: [...MOVEMENT_ACTIONS] } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit * 10, 400),
    });

    const shiftIdOf = (log: { metadata: unknown }) =>
      (log.metadata as { shiftId?: string } | null)?.shiftId;

    // La bitácora no guarda el punto, así que se averigua cuáles de los turnos
    // mencionados son de este. Se pregunta solo por esos: traer todos los turnos
    // del punto crecía con cada mes generado.
    const mentioned = [...new Set(logs.map(shiftIdOf).filter((id): id is string => Boolean(id)))];
    const ofThisLocation =
      mentioned.length > 0
        ? await this.prisma.shift.findMany({
            where: { locationId, id: { in: mentioned } },
            select: { id: true },
          })
        : [];
    const known = new Set(ofThisLocation.map((shift) => shift.id));

    return logs
      .filter((log) => {
        const shiftId = shiftIdOf(log);
        return shiftId ? known.has(shiftId) : false;
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
