import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ActorType, AssignmentStatus, ShiftStatus } from '@prisma/client';
import { AUDIT_ACTIONS, AuditService } from '../audit/audit.service';
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

export interface CancelParams {
  assignmentId: string;
  /** Quién ejecuta la baja; null cuando la origina el propio participante. */
  actorId?: string | null;
  actorType?: ActorType;
  reason?: string;
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
        },
      });

      await this.audit.record(
        {
          actorType: params.actorType ?? ActorType.PARTICIPANT,
          actorId: params.actorId ?? assignment.participantId,
          actorName: assignment.participant.fullName,
          action: AUDIT_ACTIONS.ASSIGNMENT_CANCELLED,
          entity: 'Assignment',
          entityId: assignment.id,
          before: { status: assignment.status },
          after: { status: AssignmentStatus.CANCELLED, reason: params.reason ?? null },
          metadata: { shiftId: assignment.shiftId, shiftLabel },
        },
        tx,
      );

      await this.shifts.recomputeStatus(assignment.shiftId, tx);

      return tx.assignment.count({
        where: { shiftId: assignment.shiftId, status: { in: OCCUPYING_STATUSES } },
      });
    });

    const urgent = this.time.isWithinHours(assignment.shift.startsAt, settings.urgentWindowHours);

    const cancelledEvent: AssignmentCancelledEvent = {
      locationId: location.id,
      shiftId: assignment.shiftId,
      assignmentId: assignment.id,
      participantId: assignment.participantId,
      participantName: assignment.participant.fullName,
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
      `${assignment.participant.fullName} canceló ${shiftLabel}; quedan ${remaining} de ${assignment.shift.capacity}` +
        (urgent ? ' (urgente)' : ''),
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
      remainingParticipantNames: survivors.map((item) => item.participant.fullName),
    };
    await this.events.publish(DOMAIN_EVENTS.SHIFT_LOW_STAFF, event);
  }
}
