import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AUDIT_ACTIONS, AuditService } from '../audit/audit.service';
import { greetingName } from '../common/names/person-name';
import { SettingsService } from '../common/settings/settings.service';
import {
  CoverageClosedEvent,
  CoverageDecisionEvent,
  CoverageOpenedEvent,
  DOMAIN_EVENTS,
  QuestionAnsweredEvent,
  ShiftCancelledEvent,
} from '../events/domain-events';
import { PrismaService } from '../prisma/prisma.service';
import {
  SUPERVISOR_TASK_EVENTS,
  SupervisorTaskNotification,
  SupervisorTasksService,
} from '../supervisors/supervisor-tasks.service';
import { SupervisorsService } from '../supervisors/supervisors.service';
import { MessageComposer } from './message-composer';
import { NotificationService } from './notification.service';
import { WA_TEMPLATES } from './templates';

/**
 * Convierte los hechos del dominio en mensajes de WhatsApp.
 *
 * Es el único lugar que decide *a quién* se le avisa de qué. El motor de turnos
 * ignora que existe WhatsApp, y los encargados no aparecen en su código.
 */
@Injectable()
export class NotificationListeners {
  private readonly logger = new Logger(NotificationListeners.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly composer: MessageComposer,
    private readonly supervisors: SupervisorsService,
    private readonly tasks: SupervisorTasksService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  /** Vacante abierta: se avisa por mensaje directo a todo el padrón activo. */
  @OnEvent(DOMAIN_EVENTS.COVERAGE_OPENED)
  async onCoverageOpened(event: CoverageOpenedEvent): Promise<void> {
    const settings = await this.settings.forLocation(event.locationId);

    // Mientras la convocatoria se haga con una encuesta manual en el grupo, el
    // sistema no difunde nada por su cuenta: la vacante queda abierta y visible
    // en el tablero, que es de donde sale el texto de esa encuesta.
    if (!settings.broadcastCoverageToParticipants) {
      this.logger.log(
        `Vacante de ${event.shiftLabel} abierta sin difusión automática ` +
          '(la convocatoria se hace por encuesta en el grupo)',
      );
      return;
    }

    const audience = (
      await this.notifications.broadcastAudience(event.locationId, event.excludeParticipantIds)
    ).slice(0, settings.broadcastBatchSize);

    const sent = await this.notifications.sendMany(audience, (participant) => ({
      interactive: (to) =>
        this.composer.coverageBroadcast(
          to,
          event.shiftLabel,
          event.slotsNeeded,
          event.coverageRequestId,
        ),
      template: {
        name: WA_TEMPLATES.VACANTE_DISPONIBLE,
        params: [event.shiftLabel, String(event.slotsNeeded)],
        buttonPayloads: [`CUBRIR_SEL:${event.coverageRequestId}`],
      },
      // La llave incluye a la persona: si fuera común, el aviso llegaría a una
      // sola y el resto se descartaría como duplicado.
      dedupeKey: `vacante:${event.coverageRequestId}:${event.slotsNeeded}:${participant.id}`,
    }));

    await this.prisma.coverageRequest.update({
      where: { id: event.coverageRequestId },
      data: { publishedAt: new Date(), broadcastCount: { increment: 1 } },
    });

    await this.audit.recordSystem(
      AUDIT_ACTIONS.COVERAGE_BROADCAST,
      'CoverageRequest',
      event.coverageRequestId,
      { destinatarios: sent, urgente: event.urgent },
    );

    this.logger.log(
      `Vacante de ${event.shiftLabel} difundida a ${sent} participante(s)` +
        (event.urgent ? ' (urgente)' : ''),
    );
  }

  /** Confirmación a quien fue aprobado para cubrir. */
  @OnEvent(DOMAIN_EVENTS.COVERAGE_OFFER_APPROVED)
  async onCoverageApproved(event: CoverageDecisionEvent): Promise<void> {
    await this.notifications.send(event.participantId, {
      interactive: (to) =>
        this.composer.coverageApproved(to, event.participantName, event.shiftLabel),
      template: {
        name: WA_TEMPLATES.COBERTURA_APROBADA,
        params: [event.participantName, event.shiftLabel],
      },
      dedupeKey: `cobertura-ok:${event.offerId}`,
    });
  }

  /** Agradecimiento a quienes se ofrecieron y no alcanzaron lugar. */
  @OnEvent(DOMAIN_EVENTS.COVERAGE_FULFILLED)
  async onCoverageFulfilled(event: CoverageClosedEvent): Promise<void> {
    for (const participantId of event.notSelectedParticipantIds) {
      const participant = await this.prisma.participant.findUnique({
        where: { id: participantId },
      });
      if (!participant) continue;

      await this.notifications.sendToParticipant(participant, {
        interactive: (to) =>
          this.composer.coverageNotSelected(to, greetingName(participant), event.shiftLabel),
        template: {
          name: WA_TEMPLATES.COBERTURA_AGRADECIMIENTO,
          params: [greetingName(participant), event.shiftLabel],
        },
        dedupeKey: `gracias:${event.coverageRequestId}:${participantId}`,
      });
    }
  }

  /** Turno cancelado por completo: se avisa a quienes lo tenían. */
  @OnEvent(DOMAIN_EVENTS.SHIFT_CANCELLED)
  async onShiftCancelled(event: ShiftCancelledEvent): Promise<void> {
    for (const participantId of event.affectedParticipantIds) {
      await this.notifications.send(participantId, {
        interactive: (to) => this.composer.shiftCancelledNotice(to, event.shiftLabel, event.reason),
        template: {
          name: WA_TEMPLATES.TURNO_CANCELADO,
          params: [event.shiftLabel, event.reason],
        },
        dedupeKey: `turno-cancelado:${event.shiftId}:${participantId}`,
      });
    }
  }

  /** Respuesta del encargado, firmada con su nombre y enviada por el número único. */
  @OnEvent(DOMAIN_EVENTS.QUESTION_ANSWERED)
  async onQuestionAnswered(event: QuestionAnsweredEvent): Promise<void> {
    await this.notifications.send(event.participantId, {
      interactive: (to) =>
        this.composer.answerFromSupervisor(to, event.supervisorName, event.answer),
    });
  }

  /**
   * Solicitud nueva: la reciben los encargados de guardia en ese momento.
   * Si venció el plazo, se difunde también a los que no están de guardia.
   */
  @OnEvent(SUPERVISOR_TASK_EVENTS.CREATED)
  @OnEvent(SUPERVISOR_TASK_EVENTS.ESCALATED)
  async onSupervisorTask(event: SupervisorTaskNotification): Promise<void> {
    const task = await this.tasks.findById(event.taskId);
    if (!task) return;

    const recipients = event.escalated
      ? await this.supervisors.allSupervisors(event.locationId)
      : await this.supervisors.onDutyNow(event.locationId);

    if (recipients.length === 0 && !event.escalated) {
      // Nadie de guardia: la solicitud espera en cola y el vencimiento la escalará.
      this.logger.warn(
        `Sin encargados de guardia para la solicitud ${task.id} (${task.type}); queda en espera`,
      );
      return;
    }

    await this.notifications.sendMany(recipients, (supervisor) => ({
      interactive: (to) => this.composer.supervisorTaskNotice(to, task, event.escalated),
      template: {
        // Fuera de la ventana de 24 h, el resumen y el botón de la plantilla son
        // lo único con lo que cuenta el encargado para enterarse y actuar.
        name: WA_TEMPLATES.AVISO_ENCARGADO,
        params: [this.composer.taskSummary(task)],
        buttonPayloads: [`SOL:${task.id}`],
      },
      dedupeKey: `tarea:${task.id}:${task.notifiedCount}:${supervisor.id}`,
    }));
  }
}
