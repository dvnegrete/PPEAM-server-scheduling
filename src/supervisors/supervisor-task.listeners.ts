import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { SupervisorTaskType } from '@prisma/client';
import { displayName } from '../common/names/person-name';
import {
  AssignmentCancelledEvent,
  CoverageClosedEvent,
  CoverageOfferEvent,
  DOMAIN_EVENTS,
  QuestionAskedEvent,
  ShiftLowStaffEvent,
} from '../events/domain-events';
import { CoverageService } from '../scheduling/coverage.service';
import { SupervisorTasksService } from './supervisor-tasks.service';

/**
 * Traduce lo que ocurre en el motor de turnos en trabajo para los encargados.
 * Vive aquí y no en el motor para que la lógica de turnos no dependa de la
 * existencia de encargados.
 */
@Injectable()
export class SupervisorTaskListeners {
  constructor(
    private readonly tasks: SupervisorTasksService,
    private readonly coverage: CoverageService,
  ) {}

  /**
   * Una baja no requiere aprobación, pero el encargado debe poder verificarla.
   * Si el turno es inminente, además llega marcada como urgente.
   */
  @OnEvent(DOMAIN_EVENTS.ASSIGNMENT_CANCELLED)
  async onAssignmentCancelled(event: AssignmentCancelledEvent): Promise<void> {
    await this.tasks.create({
      locationId: event.locationId,
      type: SupervisorTaskType.CANCELLATION_NOTICE,
      urgent: event.urgent,
      shiftId: event.shiftId,
      requesterId: event.participantId,
      payload: {
        participantName: event.participantName,
        shiftLabel: event.shiftLabel,
        remaining: event.remaining,
        capacity: event.capacity,
        reason: event.reason ?? null,
        bySelf: event.bySelf,
      },
    });
  }

  /** Cada ofrecimiento se acumula en una sola tarea de aprobación por vacante. */
  @OnEvent(DOMAIN_EVENTS.COVERAGE_OFFER_CREATED)
  async onCoverageOffered(event: CoverageOfferEvent): Promise<void> {
    const offers = await this.coverage.pendingOffers(event.coverageRequestId);
    const payload = {
      shiftLabel: event.shiftLabel,
      coverageRequestId: event.coverageRequestId,
      offers: offers.map((offer) => ({
        offerId: offer.id,
        participantId: offer.participantId,
        participantName: displayName(offer.participant),
        offeredAt: offer.offeredAt.toISOString(),
      })),
    };

    const existing = await this.tasks.findActiveForCoverage(
      event.coverageRequestId,
      SupervisorTaskType.COVERAGE_APPROVAL,
    );

    if (existing) {
      await this.tasks.refreshPayload(existing.id, payload, event.urgent || existing.urgent);
      return;
    }

    await this.tasks.create({
      locationId: event.locationId,
      type: SupervisorTaskType.COVERAGE_APPROVAL,
      urgent: event.urgent,
      shiftId: event.shiftId,
      coverageRequestId: event.coverageRequestId,
      payload,
    });
  }

  /** Turno bajo el mínimo operativo: el encargado decide si se mantiene o se cancela. */
  @OnEvent(DOMAIN_EVENTS.SHIFT_LOW_STAFF)
  async onLowStaff(event: ShiftLowStaffEvent): Promise<void> {
    await this.tasks.create({
      locationId: event.locationId,
      type: SupervisorTaskType.LOW_STAFF_ALERT,
      urgent: event.urgent,
      shiftId: event.shiftId,
      payload: {
        shiftLabel: event.shiftLabel,
        remaining: event.remaining,
        minCapacity: event.minCapacity,
        remainingParticipantNames: event.remainingParticipantNames,
      },
    });
  }

  /** Vacante cubierta: la tarea de aprobación deja de tener sentido. */
  @OnEvent(DOMAIN_EVENTS.COVERAGE_FULFILLED)
  async onCoverageFulfilled(event: CoverageClosedEvent): Promise<void> {
    await this.tasks.cancelForCoverageRequest(event.coverageRequestId);
  }

  @OnEvent(DOMAIN_EVENTS.COVERAGE_EXPIRED)
  async onCoverageExpired(event: CoverageClosedEvent): Promise<void> {
    await this.tasks.cancelForCoverageRequest(event.coverageRequestId);
  }

  @OnEvent(DOMAIN_EVENTS.QUESTION_ASKED)
  async onQuestionAsked(event: QuestionAskedEvent): Promise<void> {
    await this.tasks.create({
      locationId: event.locationId,
      type: SupervisorTaskType.QUESTION,
      threadId: event.threadId,
      requesterId: event.participantId,
      payload: { participantName: event.participantName, question: event.question },
    });
  }
}
