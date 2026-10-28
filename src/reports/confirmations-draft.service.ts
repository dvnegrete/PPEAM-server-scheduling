import { BadRequestException, Injectable } from '@nestjs/common';
import { ActorType, AssignmentOrigin } from '@prisma/client';
import { AUDIT_ACTIONS, AuditService } from '../audit/audit.service';
import { fullName } from '../common/names/person-name';
import { TimeService } from '../common/time/time.service';
import { PrismaService } from '../prisma/prisma.service';
import { OCCUPYING_STATUSES } from '../scheduling/shifts.service';

/** Días por delante que se miran cuando no se pide otro horizonte. */
export const CONFIRMATION_DAYS_DEFAULT = 14;

/** Una persona que cubre un turno y a la que todavía no se le ha confirmado. */
export interface ConfirmationRow {
  /**
   * `${shiftId}:${participantId}`. Es la misma clave que usa la bitácora para
   * `assignment.created`, y es lo que el panel devuelve al confirmar.
   */
  key: string;
  shiftId: string;
  participantId: string;
  date: string;
  /** «Sáb. 31» */
  dayLabel: string;
  /** «09:00 a 11:00 am» */
  range: string;
  startMinute: number;
  endMinute: number;
  /** Nombre completo: lo que va dentro de los corchetes y lo que se lee en la lista. */
  name: string;
  assignedAt: string | null;
  assignedByName: string | null;
}

export interface ConfirmationsDraft {
  rows: ConfirmationRow[];
  /** El mensaje ya redactado con `rows`; el panel lo rearma al quitar líneas. */
  text: string;
}

export interface AnnounceResult {
  /** Claves que esta llamada dejó registradas. */
  announced: string[];
  /** Las que ya había marcado alguien más; no se registran dos veces. */
  alreadyAnnounced: string[];
  draft: ConfirmationsDraft;
}

interface Actor {
  id?: string | null;
  name?: string | null;
}

/**
 * Arma el mensaje con el que se confirma en el grupo a quien va a cubrir un turno.
 *
 * El sistema no lo publica: mientras no haya API de WhatsApp, lo pega un encargado
 * a mano, igual que la encuesta. Lo que sí hace es redactarlo y, cuando el
 * encargado confirma que ya lo publicó, dejarlo anotado en la bitácora para que
 * nadie vuelva a salir en el mensaje siguiente.
 *
 * Los nombres salen **entre corchetes** a propósito: una mención de WhatsApp no
 * viaja en el texto —el cliente la adjunta como metadato—, así que un «@Nombre»
 * pegado no notificaría a nadie. El corchete marca dónde tiene que etiquetar la
 * persona que publica, y con el nombre completo para que no dude entre dos
 * participantes que se llamen igual.
 */
@Injectable()
export class ConfirmationsDraftService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly time: TimeService,
    private readonly audit: AuditService,
  ) {}

  async build(
    locationId: string,
    days: number = CONFIRMATION_DAYS_DEFAULT,
  ): Promise<ConfirmationsDraft> {
    const todas = await this.vigentes(locationId, days);
    const anunciadas = await this.anunciadas(todas.map((row) => row.key));
    const rows = todas.filter((row) => !anunciadas.has(row.key));
    return { rows, text: this.text(rows) };
  }

  /**
   * Deja constancia de que estas confirmaciones ya se publicaron en el grupo.
   *
   * No comprueba que el turno siga en el futuro: si el encargado publicó el
   * mensaje y vuelve a confirmarlo cuando el turno ya empezó, lo que importa es
   * que quede registrado. Lo que sí exige es que la asignación siga en pie y sea
   * de este punto, para que una clave inventada no ensucie la bitácora.
   */
  async announce(locationId: string, keys: string[], actor: Actor): Promise<AnnounceResult> {
    const unicas = [...new Set(keys)];
    const pares = unicas.map((key) => this.parseKey(key));

    const assignments = await this.prisma.assignment.findMany({
      where: {
        origin: AssignmentOrigin.COVERAGE,
        status: { in: OCCUPYING_STATUSES },
        shift: { locationId },
        OR: pares.map((par) => ({ shiftId: par.shiftId, participantId: par.participantId })),
      },
      include: {
        shift: { include: { location: { select: { timezone: true } } } },
        participant: {
          select: {
            firstName: true,
            paternalSurname: true,
            maternalSurname: true,
            displayName: true,
          },
        },
      },
    });

    const encontradas = new Map(
      assignments.map((assignment) => [
        `${assignment.shiftId}:${assignment.participantId}`,
        assignment,
      ]),
    );
    const desconocidas = unicas.filter((key) => !encontradas.has(key));
    if (desconocidas.length > 0) {
      throw new BadRequestException(
        desconocidas.length === 1
          ? 'Una de las confirmaciones ya no está vigente en este punto; vuelve a cargar la lista'
          : `${desconocidas.length} de las confirmaciones ya no están vigentes en este punto; vuelve a cargar la lista`,
      );
    }

    const yaEstaban = await this.anunciadas(unicas);
    const nuevas = unicas.filter((key) => !yaEstaban.has(key));

    // En una transacción para que no queden a medias: o se anotan todas las que
    // el encargado declaró, o ninguna y lo vuelve a intentar.
    if (nuevas.length > 0) {
      await this.prisma.$transaction(async (tx) => {
        for (const key of nuevas) {
          const assignment = encontradas.get(key)!;
          await this.audit.record(
            {
              actorType: ActorType.ADMIN,
              actorId: actor.id ?? null,
              actorName: actor.name ?? null,
              action: AUDIT_ACTIONS.COVERAGE_ANNOUNCED,
              entity: 'Assignment',
              entityId: key,
              metadata: {
                shiftId: assignment.shiftId,
                shiftLabel: this.time.formatShiftLabel(
                  assignment.shift.date,
                  assignment.shift.startMinute,
                  assignment.shift.endMinute,
                  assignment.shift.location.timezone,
                ),
                participantName: fullName(assignment.participant),
              },
            },
            tx,
          );
        }
      });
    }

    return {
      announced: nuevas,
      alreadyAnnounced: unicas.filter((key) => yaEstaban.has(key)),
      draft: await this.build(locationId),
    };
  }

  /** Coberturas vigentes del punto en el horizonte, anunciadas o no. */
  private async vigentes(locationId: string, days: number): Promise<ConfirmationRow[]> {
    const location = await this.prisma.location.findUniqueOrThrow({
      where: { id: locationId },
      select: { timezone: true },
    });

    const desde = this.time.now();
    const hasta = new Date(desde.getTime() + days * 24 * 60 * 60 * 1000);

    const assignments = await this.prisma.assignment.findMany({
      where: {
        origin: AssignmentOrigin.COVERAGE,
        status: { in: OCCUPYING_STATUSES },
        shift: { locationId, startsAt: { gte: desde, lte: hasta } },
      },
      include: {
        shift: true,
        participant: {
          select: {
            firstName: true,
            paternalSurname: true,
            maternalSurname: true,
            displayName: true,
          },
        },
      },
      orderBy: [
        { shift: { date: 'asc' } },
        { shift: { startMinute: 'asc' } },
        { participant: { firstName: 'asc' } },
      ],
    });

    return assignments.map((assignment) => ({
      key: `${assignment.shiftId}:${assignment.participantId}`,
      shiftId: assignment.shiftId,
      participantId: assignment.participantId,
      date: assignment.shift.date.toISOString().slice(0, 10),
      dayLabel: this.time.formatDayShort(assignment.shift.date, location.timezone),
      range: this.time.formatRange12(assignment.shift.startMinute, assignment.shift.endMinute),
      startMinute: assignment.shift.startMinute,
      endMinute: assignment.shift.endMinute,
      name: fullName(assignment.participant),
      assignedAt: assignment.assignedAt?.toISOString() ?? null,
      assignedByName: assignment.assignedByName,
    }));
  }

  /** Cuáles de estas claves ya tienen su entrada en la bitácora. */
  private async anunciadas(keys: string[]): Promise<Set<string>> {
    if (keys.length === 0) return new Set();
    const logs = await this.prisma.auditLog.findMany({
      where: { action: AUDIT_ACTIONS.COVERAGE_ANNOUNCED, entityId: { in: keys } },
      select: { entityId: true },
    });
    return new Set(
      logs.map((log) => log.entityId).filter((id): id is string => typeof id === 'string'),
    );
  }

  private parseKey(key: string): { shiftId: string; participantId: string } {
    const [shiftId, participantId, ...resto] = key.split(':');
    if (!shiftId || !participantId || resto.length > 0) {
      throw new BadRequestException(`Clave de confirmación inválida: ${key}`);
    }
    return { shiftId, participantId };
  }

  /**
   * El mensaje, con una línea por turno.
   *
   * Sin negritas y con el encabezado que ya se usa en el grupo, para que lo que
   * se pega sea indistinguible de lo que hasta ahora se escribía a mano.
   */
  private text(rows: ConfirmationRow[]): string {
    if (rows.length === 0) {
      return 'No hay confirmaciones pendientes de publicar.';
    }

    const porTurno = new Map<string, ConfirmationRow[]>();
    for (const row of rows) {
      const grupo = porTurno.get(row.shiftId);
      if (grupo) grupo.push(row);
      else porTurno.set(row.shiftId, [row]);
    }

    const encabezado =
      porTurno.size === 1
        ? 'Confirmamos el siguiente horario:'
        : 'Confirmamos los siguientes horarios:';

    const lineas = [...porTurno.values()].map((grupo) => {
      const nombres = this.enumerar(grupo.map((row) => `[${row.name}]`));
      return `- ${grupo[0].dayLabel} de ${grupo[0].range}: ${nombres}`;
    });

    return `${encabezado}\n${lineas.join('\n')}`;
  }

  /** «A», «A y B», «A, B y C». */
  private enumerar(partes: string[]): string {
    if (partes.length <= 1) return partes.join('');
    return `${partes.slice(0, -1).join(', ')} y ${partes[partes.length - 1]}`;
  }
}
