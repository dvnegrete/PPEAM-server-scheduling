import { Injectable, Logger } from '@nestjs/common';
import {
  ActorType,
  AssignmentStatus,
  Participant,
  ShiftStatus,
  SupervisorTask,
  SupervisorTaskType,
} from '@prisma/client';
import { AUDIT_ACTIONS, AuditService } from '../audit/audit.service';
import { TimeService } from '../common/time/time.service';
import { DomainEventBus } from '../events/domain-event-bus';
import { DOMAIN_EVENTS, ShiftCancelledEvent } from '../events/domain-events';
import { MessageComposer } from '../messaging/message-composer';
import { PrismaService } from '../prisma/prisma.service';
import { CoverageService } from '../scheduling/coverage.service';
import { OCCUPYING_STATUSES, ShiftsService } from '../scheduling/shifts.service';
import {
  SupervisorTasksService,
  TaskAlreadyHandledError,
} from '../supervisors/supervisor-tasks.service';
import { SupervisorsService } from '../supervisors/supervisors.service';
import { ThreadsService } from '../threads/threads.service';
import { OutboxService } from '../whatsapp/outbox.service';
import { OutgoingMessage } from '../whatsapp/types/message.types';
import { ACTIONS } from './reply-ids';
import { SESSION_STATES, SessionService } from './session.service';

/**
 * Lo que solo pueden hacer los encargados.
 *
 * Toda acción pasa primero por reclamar la solicitud: si otro encargado se
 * adelantó, este recibe un aviso claro en vez de duplicar el trabajo o pisar
 * una decisión ya tomada.
 */
@Injectable()
export class SupervisorFlow {
  private readonly logger = new Logger(SupervisorFlow.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly composer: MessageComposer,
    private readonly outbox: OutboxService,
    private readonly supervisors: SupervisorsService,
    private readonly tasks: SupervisorTasksService,
    private readonly coverage: CoverageService,
    private readonly shifts: ShiftsService,
    private readonly threads: ThreadsService,
    private readonly audit: AuditService,
    private readonly events: DomainEventBus,
    private readonly time: TimeService,
  ) {}

  async handle(
    participant: Participant,
    locationId: string,
    action: string,
    args: string[],
  ): Promise<void> {
    if (!(await this.supervisors.isSupervisor(participant.id))) {
      await this.send(participant, this.composer.notUnderstood(participant.phoneE164));
      return;
    }

    switch (action) {
      case ACTIONS.TASKS:
        return this.listPendingTasks(participant, locationId);

      case ACTIONS.TASK_OPEN:
        return this.openTask(participant, locationId, args[0]);

      case ACTIONS.ACK:
        return this.acknowledge(participant, args[0]);

      case ACTIONS.OFFER_APPROVE:
        return this.approveOffer(participant, args[0]);

      case ACTIONS.OFFER_DECLINE:
        return this.declineOffer(participant, args[0]);

      case ACTIONS.SHIFT_KEEP:
        return this.keepShift(participant, args[0]);

      case ACTIONS.SHIFT_CANCEL:
        return this.cancelShift(participant, args[0]);

      case ACTIONS.THREAD_REPLY:
        return this.startAnswer(participant, locationId, args[0]);

      case ACTIONS.DUTY_STATUS:
        return this.showDutyStatus(participant, locationId);

      case ACTIONS.DUTY_ON:
        await this.supervisors.setAvailable(participant.id);
        return this.send(
          participant,
          this.composer.taskResolvedByYou(
            participant.phoneE164,
            'Listo, ya estás recibiendo solicitudes. Avísame cuando quieras desconectarte.',
          ),
        );

      case ACTIONS.DUTY_OFF:
        await this.supervisors.setUnavailable(participant.id);
        return this.send(
          participant,
          this.composer.taskResolvedByYou(
            participant.phoneE164,
            'Listo, no recibirás solicitudes hasta que vuelvas a conectarte. ' +
              'Tus franjas habituales quedan en pausa.',
          ),
        );

      default:
        return this.send(participant, this.composer.notUnderstood(participant.phoneE164));
    }
  }

  private async listPendingTasks(participant: Participant, locationId: string): Promise<void> {
    const location = await this.prisma.location.findUniqueOrThrow({ where: { id: locationId } });
    const pending = await this.tasks.pendingFor(locationId);
    await this.send(
      participant,
      this.composer.pendingTasks(participant.phoneE164, pending, location.timezone),
    );
  }

  private async showDutyStatus(participant: Participant, locationId: string): Promise<void> {
    const status = await this.supervisors.dutyStatus(participant.id, locationId);
    await this.send(
      participant,
      this.composer.dutyStatus(participant.phoneE164, status.onDuty, status.windows),
    );
  }

  /** Abre una solicitud reclamándola primero, para que no la trabajen dos. */
  private async openTask(
    participant: Participant,
    locationId: string,
    taskId: string,
  ): Promise<void> {
    const task = await this.claim(participant, taskId);
    if (!task) return;

    switch (task.type) {
      case SupervisorTaskType.COVERAGE_APPROVAL:
        return this.showOffers(participant, locationId, task);

      case SupervisorTaskType.QUESTION:
        return this.startAnswer(participant, locationId, task.id);

      default:
        return this.send(
          participant,
          this.composer.supervisorTaskNotice(participant.phoneE164, task, false),
        );
    }
  }

  private async showOffers(
    participant: Participant,
    locationId: string,
    task: SupervisorTask,
  ): Promise<void> {
    if (!task.coverageRequestId) return;

    const location = await this.prisma.location.findUniqueOrThrow({ where: { id: locationId } });
    const offers = await this.coverage.pendingOffers(task.coverageRequestId);

    if (offers.length === 0) {
      await this.send(
        participant,
        this.composer.taskResolvedByYou(
          participant.phoneE164,
          'Ya no hay ofrecimientos pendientes para ese turno.',
        ),
      );
      return;
    }

    const payload = task.payload as { shiftLabel?: string };
    await this.send(
      participant,
      this.composer.offersToApprove(
        participant.phoneE164,
        payload.shiftLabel ?? 'el turno',
        offers.map((offer) => ({
          offerId: offer.id,
          participantName: offer.participant.fullName,
          offeredAt: offer.offeredAt,
        })),
        location.timezone,
      ),
    );
  }

  private async approveOffer(participant: Participant, offerId: string): Promise<void> {
    const offer = await this.prisma.coverageOffer.findUnique({
      where: { id: offerId },
      include: { participant: true, coverageRequest: true },
    });
    if (!offer) {
      await this.send(participant, this.composer.taskAlreadyHandled(participant.phoneE164));
      return;
    }

    try {
      await this.coverage.approve(offerId, participant.id);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'No se pudo aprobar';
      await this.send(
        participant,
        this.composer.taskResolvedByYou(participant.phoneE164, detail),
      );
      return;
    }

    const task = await this.tasks.findActiveForCoverage(
      offer.coverageRequestId,
      SupervisorTaskType.COVERAGE_APPROVAL,
    );
    if (task) {
      await this.tasks.resolve(
        task.id,
        participant.id,
        `Aprobado: ${offer.participant.fullName}`,
      );
    }

    await this.send(
      participant,
      this.composer.taskResolvedByYou(
        participant.phoneE164,
        `Listo. ${offer.participant.fullName} queda confirmado y ya se le avisó. ` +
          'A quienes no alcanzaron lugar les enviamos un agradecimiento.',
      ),
    );
  }

  private async declineOffer(participant: Participant, offerId: string): Promise<void> {
    await this.coverage.decline(offerId, participant.id);
    await this.send(
      participant,
      this.composer.taskResolvedByYou(participant.phoneE164, 'Ofrecimiento descartado.'),
    );
  }

  private async acknowledge(participant: Participant, taskId: string): Promise<void> {
    const task = await this.claim(participant, taskId);
    if (!task) return;

    await this.tasks.resolve(taskId, participant.id, 'Revisado por el encargado');
    await this.send(
      participant,
      this.composer.taskResolvedByYou(participant.phoneE164, 'Gracias, queda registrado.'),
    );
  }

  /** El encargado decide sostener el turno aunque esté por debajo del mínimo. */
  private async keepShift(participant: Participant, taskId: string): Promise<void> {
    const task = await this.claim(participant, taskId);
    if (!task?.shiftId) return;

    await this.audit.record({
      actorType: ActorType.SUPERVISOR,
      actorId: participant.id,
      actorName: participant.fullName,
      action: AUDIT_ACTIONS.SHIFT_KEPT,
      entity: 'Shift',
      entityId: task.shiftId,
    });

    await this.tasks.resolve(taskId, participant.id, 'Se mantiene el turno');
    await this.send(
      participant,
      this.composer.taskResolvedByYou(
        participant.phoneE164,
        'De acuerdo, el turno se mantiene. Seguimos buscando quien lo refuerce.',
      ),
    );
  }

  /** Cancela el turno completo y avisa a quienes lo tenían. */
  private async cancelShift(participant: Participant, taskId: string): Promise<void> {
    const task = await this.claim(participant, taskId);
    if (!task?.shiftId) return;

    const shift = await this.prisma.shift.findUniqueOrThrow({
      where: { id: task.shiftId },
      include: { location: true, assignments: { where: { status: { in: OCCUPYING_STATUSES } } } },
    });
    const label = this.shifts.label(shift, shift.location.timezone);
    const affected = shift.assignments.map((item) => item.participantId);

    await this.prisma.$transaction([
      this.prisma.shift.update({
        where: { id: shift.id },
        data: {
          status: ShiftStatus.CANCELLED,
          cancelledAt: this.time.now(),
          cancelledReason: 'Sin personal suficiente',
        },
      }),
      this.prisma.assignment.updateMany({
        where: { shiftId: shift.id, status: { in: OCCUPYING_STATUSES } },
        data: {
          status: AssignmentStatus.CANCELLED,
          cancelledAt: this.time.now(),
          cancelReason: 'Turno cancelado por falta de participantes',
        },
      }),
    ]);

    await this.audit.record({
      actorType: ActorType.SUPERVISOR,
      actorId: participant.id,
      actorName: participant.fullName,
      action: AUDIT_ACTIONS.SHIFT_CANCELLED,
      entity: 'Shift',
      entityId: shift.id,
      metadata: { afectados: affected.length },
    });

    await this.tasks.resolve(taskId, participant.id, 'Turno cancelado');

    await this.events.publish(DOMAIN_EVENTS.SHIFT_CANCELLED, {
      locationId: shift.locationId,
      shiftId: shift.id,
      shiftLabel: label,
      reason: 'No se alcanzó el mínimo de participantes',
      affectedParticipantIds: affected,
    } satisfies ShiftCancelledEvent);

    await this.send(
      participant,
      this.composer.taskResolvedByYou(
        participant.phoneE164,
        `El turno ${label} quedó cancelado y ya se avisó a los participantes.`,
      ),
    );

    this.logger.warn(`${participant.fullName} canceló el turno ${label} por falta de personal`);
  }

  /** Pide al encargado que escriba su respuesta a una pregunta. */
  private async startAnswer(
    participant: Participant,
    locationId: string,
    taskId: string,
  ): Promise<void> {
    const task = await this.claim(participant, taskId);
    if (!task?.threadId) return;

    const thread = await this.threads.findById(task.threadId);
    if (!thread) return;

    await this.sessions.set(participant.id, locationId, SESSION_STATES.AWAITING_ANSWER, {
      threadId: task.threadId,
      taskId: task.id,
    });

    const question = thread.messages[0]?.body ?? '';
    await this.send(
      participant,
      this.composer.askForAnswer(participant.phoneE164, thread.participant.fullName, question),
    );
  }

  /** Entrega la respuesta al participante, firmada con el nombre del encargado. */
  async deliverAnswer(
    supervisor: Participant,
    threadId: string,
    taskId: string | undefined,
    answer: string,
  ): Promise<void> {
    const thread = await this.threads.findById(threadId);
    if (!thread) return;

    await this.threads.answer(threadId, supervisor.id, answer);

    if (taskId) {
      await this.tasks.resolve(taskId, supervisor.id, 'Pregunta respondida');
    }

    await this.send(
      supervisor,
      this.composer.answerDelivered(supervisor.phoneE164, thread.participant.fullName),
    );
  }

  /** Reclama la solicitud; si otro se adelantó, avisa y devuelve null. */
  private async claim(
    participant: Participant,
    taskId: string,
  ): Promise<SupervisorTask | null> {
    try {
      return await this.tasks.claim(taskId, participant.id);
    } catch (error) {
      if (error instanceof TaskAlreadyHandledError) {
        await this.send(participant, this.composer.taskAlreadyHandled(participant.phoneE164));
        return null;
      }
      throw error;
    }
  }

  private async send(participant: Participant, message: OutgoingMessage): Promise<void> {
    await this.outbox.enqueue(message, { participantId: participant.id });
  }
}
