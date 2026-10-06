import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ActorType, AssignmentStatus, ShiftStatus } from '@prisma/client';
import { AUDIT_ACTIONS, AuditService } from '../audit/audit.service';
import { displayName, fullName } from '../common/names/person-name';
import { SettingsService } from '../common/settings/settings.service';
import { TimeService } from '../common/time/time.service';
import { DomainEventBus } from '../events/domain-event-bus';
import {
  AssignmentCancelledEvent,
  AssignmentConfirmedEvent,
  DOMAIN_EVENTS,
  ShiftLowStaffEvent,
} from '../events/domain-events';
import { PrismaService } from '../prisma/prisma.service';
import { CoverageService } from './coverage.service';
import { OCCUPYING_STATUSES, ShiftsService } from './shifts.service';

/** Motivos frecuentes, para poder agruparlos en los reportes. */
export const CANCEL_REASON_CODES = ['enfermedad', 'trabajo', 'viaje', 'otro'] as const;
export type CancelReasonCode = (typeof CANCEL_REASON_CODES)[number];

export interface CancelParams {
  assignmentId: string;
  /** Quién ejecuta la baja; null cuando la origina el propio participante. */
  actorId?: string | null;
  actorType?: ActorType;
  /** Nombre de quien la captura, para mostrarlo en el tablero sin más consultas. */
  actorName?: string | null;
  reason?: string;
  /**
   * Motivo de la lista corta. Se tipa como texto porque el panel puede agregar
   * motivos propios sin tocar el dominio; la validación vive en el DTO.
   */
  reasonCode?: string;
  /**
   * Si hay que convocar a alguien para el hueco. Por omisión sí.
   *
   * Con `false` se cancela en silencio: no se publica el evento —que avisa al
   * encargado—, no se abre la cobertura y no se emite la alerta de falta de
   * gente. Es lo que necesita una baja administrativa: dar de baja a quien tiene
   * quince turnos futuros abriría quince convocatorias y saturaría el grupo de
   * golpe, cuando lo que toca es que el administrador decida cuándo convocar.
   *
   * La bitácora y el recálculo del turno **no** se omiten nunca: van dentro de
   * la transacción y son el rastro del movimiento.
   */
  notify?: boolean;
}

@Injectable()
export class AssignmentsService {
  private readonly logger = new Logger(AssignmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly time: TimeService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly shifts: ShiftsService,
    private readonly coverage: CoverageService,
    private readonly events: DomainEventBus,
  ) {}

  /**
   * Da de baja a un participante de su turno.
   *
   * La baja se aplica de inmediato, sin esperar la aprobación de nadie: esa
   * espera es justamente el problema que el sistema viene a resolver. El
   * encargado se entera enseguida y puede revisarla, pero nunca la bloquea.
   */
  async cancel(params: CancelParams): Promise<void> {
    const assignment = await this.prisma.assignment.findUnique({
      where: { id: params.assignmentId },
      include: { shift: { include: { location: true } }, participant: true },
    });
    if (!assignment) throw new NotFoundException(`No existe la asignación ${params.assignmentId}`);

    if (assignment.status === AssignmentStatus.CANCELLED) {
      throw new BadRequestException('Ese turno ya estaba cancelado');
    }
    if (assignment.shift.status === ShiftStatus.CANCELLED) {
      throw new BadRequestException('Ese turno fue cancelado por completo');
    }
    if (assignment.shift.endsAt < this.time.now()) {
      throw new BadRequestException('Ese turno ya pasó');
    }

    const location = assignment.shift.location;
    const settings = this.settings.resolve(location);
    const shiftLabel = this.shifts.label(assignment.shift, location.timezone);

    const remaining = await this.prisma.$transaction(async (tx) => {
      await tx.assignment.update({
        where: { id: assignment.id },
        data: {
          status: AssignmentStatus.CANCELLED,
          cancelledAt: this.time.now(),
          cancelReason: params.reason ?? null,
          cancelReasonCode: params.reasonCode ?? null,
          // Quien captura la baja; si la origina el propio participante, es él mismo.
          cancelledByName: params.actorName ?? fullName(assignment.participant),
        },
      });

      await this.audit.record(
        {
          actorType: params.actorType ?? ActorType.PARTICIPANT,
          actorId: params.actorId ?? assignment.participantId,
          actorName: params.actorName ?? fullName(assignment.participant),
          action: AUDIT_ACTIONS.ASSIGNMENT_CANCELLED,
          entity: 'Assignment',
          entityId: assignment.id,
          before: { status: assignment.status },
          after: {
            status: AssignmentStatus.CANCELLED,
            reason: params.reason ?? null,
            reasonCode: params.reasonCode ?? null,
          },
          metadata: {
            shiftId: assignment.shiftId,
            shiftLabel,
            participantName: fullName(assignment.participant),
          },
        },
        tx,
      );

      await this.shifts.recomputeStatus(assignment.shiftId, tx);

      return tx.assignment.count({
        where: { shiftId: assignment.shiftId, status: { in: OCCUPYING_STATUSES } },
      });
    });

    if (params.notify === false) {
      this.logger.log(
        `${displayName(assignment.participant)} queda fuera de ${shiftLabel} sin convocatoria; ` +
          `quedan ${remaining} de ${assignment.shift.capacity}`,
      );
      return;
    }

    const urgent = this.time.isWithinHours(assignment.shift.startsAt, settings.urgentWindowHours);

    const cancelledEvent: AssignmentCancelledEvent = {
      locationId: location.id,
      shiftId: assignment.shiftId,
      assignmentId: assignment.id,
      participantId: assignment.participantId,
      participantName: fullName(assignment.participant),
      remaining,
      capacity: assignment.shift.capacity,
      minCapacity: location.minCapacity,
      urgent,
      shiftLabel,
      startsAt: assignment.shift.startsAt,
      reason: params.reason,
      bySelf: !params.actorId || params.actorId === assignment.participantId,
    };
    await this.events.publish(DOMAIN_EVENTS.ASSIGNMENT_CANCELLED, cancelledEvent);

    // Abrir la vacante es parte del mismo acto: quien cancela deja un hueco que
    // hay que publicar cuanto antes.
    await this.coverage.openForShift(assignment.shiftId, { urgent });

    if (remaining > 0 && remaining < location.minCapacity) {
      await this.emitLowStaff(assignment.shiftId, shiftLabel, remaining, location, urgent);
    }

    this.logger.log(
      `${displayName(assignment.participant)} canceló ${shiftLabel}; quedan ${remaining} de ${assignment.shift.capacity}` +
        (urgent ? ' (urgente)' : ''),
    );
  }

  /**
   * Sienta a un participante en un turno por decisión de un administrador.
   *
   * Es el cierre del ciclo cuando la convocatoria se hace por fuera del sistema:
   * alguien responde la encuesta del grupo y el administrador lo registra aquí
   * para que el tablero vuelva a reflejar la realidad.
   *
   * El bloqueo de fila sobre el turno es el mismo que usa la aprobación de
   * coberturas: sin él, dos administradores registrando a la vez la respuesta de
   * dos personas distintas podrían dejar el turno con más gente que su cupo.
   */
  async assignManually(params: {
    shiftId: string;
    participantId: string;
    actorId?: string | null;
    actorName?: string | null;
    actorType?: ActorType;
  }): Promise<void> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM shifts WHERE id = ${params.shiftId} FOR UPDATE`;

      const shift = await tx.shift.findUnique({
        where: { id: params.shiftId },
        include: { location: true },
      });
      if (!shift) throw new NotFoundException('Ese turno ya no existe');
      if (shift.status === ShiftStatus.CANCELLED) {
        throw new BadRequestException('Ese turno está cancelado');
      }

      const participant = await tx.participant.findUnique({
        where: { id: params.participantId },
      });
      if (!participant) throw new NotFoundException('Ese participante ya no existe');
      if (participant.status !== 'ACTIVE') {
        throw new BadRequestException(`${displayName(participant)} no está activo en el padrón`);
      }

      const occupied = await tx.assignment.count({
        where: { shiftId: shift.id, status: { in: OCCUPYING_STATUSES } },
      });
      if (occupied >= shift.capacity) {
        throw new BadRequestException('Ese turno ya está completo');
      }

      const existing = await tx.assignment.findUnique({
        where: {
          shiftId_participantId: { shiftId: shift.id, participantId: participant.id },
        },
      });
      if (existing && OCCUPYING_STATUSES.includes(existing.status)) {
        throw new BadRequestException(`${displayName(participant)} ya tiene lugar en ese turno`);
      }

      // La fila se reutiliza si esta persona había cancelado antes: el índice único
      // lo exige. Por eso se limpian los datos de la baja y se sella la fecha nueva.
      await tx.assignment.upsert({
        where: {
          shiftId_participantId: { shiftId: shift.id, participantId: participant.id },
        },
        create: {
          shiftId: shift.id,
          participantId: participant.id,
          origin: 'COVERAGE',
          status: AssignmentStatus.ASSIGNED,
          assignedAt: this.time.now(),
          assignedByName: params.actorName ?? null,
        },
        update: {
          origin: 'COVERAGE',
          status: AssignmentStatus.ASSIGNED,
          assignedAt: this.time.now(),
          assignedByName: params.actorName ?? null,
          cancelledAt: null,
          cancelReason: null,
          cancelReasonCode: null,
          cancelledByName: null,
          confirmedAt: null,
          remindedAt: null,
        },
      });

      // Si el turno quedó cubierto, la vacante abierta deja de tener sentido.
      const ocupadosAhora = occupied + 1;
      if (ocupadosAhora >= shift.capacity) {
        await tx.coverageRequest.updateMany({
          where: { shiftId: shift.id, status: 'OPEN' },
          data: { status: 'FULFILLED' },
        });
      }

      await this.shifts.recomputeStatus(shift.id, tx);

      const shiftLabel = this.shifts.label(shift, shift.location.timezone);
      await this.audit.record(
        {
          actorType: params.actorType ?? ActorType.ADMIN,
          actorId: params.actorId ?? null,
          actorName: params.actorName ?? null,
          action: AUDIT_ACTIONS.ASSIGNMENT_CREATED,
          entity: 'Assignment',
          entityId: `${shift.id}:${participant.id}`,
          after: { participantId: participant.id, origin: 'COVERAGE' },
          metadata: {
            shiftId: shift.id,
            shiftLabel,
            participantName: fullName(participant),
            manual: true,
          },
        },
        tx,
      );

      return { shiftLabel, participantName: displayName(participant) };
    });

    this.logger.log(
      `${outcome.participantName} queda asignado a ${outcome.shiftLabel}` +
        (params.actorName ? ` (registrado por ${params.actorName})` : ''),
    );
  }

  /** El participante confirma que sí asistirá (respuesta al recordatorio). */
  async confirm(assignmentId: string): Promise<void> {
    const assignment = await this.prisma.assignment.findUnique({
      where: { id: assignmentId },
      include: { shift: { include: { location: true } } },
    });
    if (!assignment) throw new NotFoundException(`No existe la asignación ${assignmentId}`);
    if (assignment.status === AssignmentStatus.CANCELLED) {
      throw new BadRequestException('Ese turno ya fue cancelado');
    }
    if (assignment.status === AssignmentStatus.CONFIRMED) return;

    await this.prisma.assignment.update({
      where: { id: assignmentId },
      data: { status: AssignmentStatus.CONFIRMED, confirmedAt: this.time.now() },
    });

    await this.audit.record({
      actorType: ActorType.PARTICIPANT,
      actorId: assignment.participantId,
      action: AUDIT_ACTIONS.ASSIGNMENT_CONFIRMED,
      entity: 'Assignment',
      entityId: assignmentId,
      metadata: { shiftId: assignment.shiftId },
    });

    const event: AssignmentConfirmedEvent = {
      locationId: assignment.shift.locationId,
      shiftId: assignment.shiftId,
      assignmentId,
      participantId: assignment.participantId,
      shiftLabel: this.shifts.label(assignment.shift, assignment.shift.location.timezone),
    };
    await this.events.publish(DOMAIN_EVENTS.ASSIGNMENT_CONFIRMED, event);
  }

  private async emitLowStaff(
    shiftId: string,
    shiftLabel: string,
    remaining: number,
    location: { id: string; minCapacity: number },
    urgent: boolean,
  ): Promise<void> {
    const survivors = await this.prisma.assignment.findMany({
      where: { shiftId, status: { in: OCCUPYING_STATUSES } },
      include: { participant: true },
    });

    const event: ShiftLowStaffEvent = {
      locationId: location.id,
      shiftId,
      shiftLabel,
      startsAt: (await this.shifts.findById(shiftId)).startsAt,
      remaining,
      minCapacity: location.minCapacity,
      urgent,
      remainingParticipantNames: survivors.map((item) => displayName(item.participant)),
    };
    await this.events.publish(DOMAIN_EVENTS.SHIFT_LOW_STAFF, event);
  }
}
