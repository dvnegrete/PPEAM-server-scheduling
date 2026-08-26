/**
 * Eventos de dominio.
 *
 * El motor de turnos no conoce a los encargados ni a la mensajería: publica lo
 * que ocurrió y otros módulos deciden qué hacer. Así se evita el ciclo
 * turnos → notificaciones → turnos, y agregar un nuevo aviso no obliga a tocar
 * la lógica de negocio.
 */

export const DOMAIN_EVENTS = {
  ASSIGNMENT_CANCELLED: 'assignment.cancelled',
  ASSIGNMENT_CONFIRMED: 'assignment.confirmed',
  COVERAGE_OPENED: 'coverage.opened',
  COVERAGE_OFFER_CREATED: 'coverage.offer.created',
  COVERAGE_OFFER_APPROVED: 'coverage.offer.approved',
  COVERAGE_OFFER_DECLINED: 'coverage.offer.declined',
  COVERAGE_FULFILLED: 'coverage.fulfilled',
  COVERAGE_EXPIRED: 'coverage.expired',
  SHIFT_LOW_STAFF: 'shift.low_staff',
  SHIFT_CANCELLED: 'shift.cancelled',
  QUESTION_ASKED: 'question.asked',
  QUESTION_ANSWERED: 'question.answered',
} as const;

export interface AssignmentCancelledEvent {
  locationId: string;
  shiftId: string;
  assignmentId: string;
  participantId: string;
  participantName: string;
  /** Ocupantes que quedan tras la baja. */
  remaining: number;
  capacity: number;
  minCapacity: number;
  urgent: boolean;
  shiftLabel: string;
  startsAt: Date;
  reason?: string;
  /** Quién originó la baja: la persona misma o el sistema/panel. */
  bySelf: boolean;
}

export interface AssignmentConfirmedEvent {
  locationId: string;
  shiftId: string;
  assignmentId: string;
  participantId: string;
  shiftLabel: string;
}

export interface CoverageOpenedEvent {
  locationId: string;
  coverageRequestId: string;
  shiftId: string;
  slotsNeeded: number;
  urgent: boolean;
  shiftLabel: string;
  startsAt: Date;
  /** Participantes que ya están en el turno; no se les vuelve a ofrecer. */
  excludeParticipantIds: string[];
}

export interface CoverageOfferEvent {
  locationId: string;
  coverageRequestId: string;
  offerId: string;
  shiftId: string;
  participantId: string;
  participantName: string;
  shiftLabel: string;
  urgent: boolean;
}

export interface CoverageDecisionEvent extends CoverageOfferEvent {
  decidedById: string | null;
  decidedByName: string | null;
  /** true cuando la resolvió el sistema al vencer el plazo sin encargados. */
  automatic: boolean;
}

export interface CoverageClosedEvent {
  locationId: string;
  coverageRequestId: string;
  shiftId: string;
  shiftLabel: string;
  /** Ofrecimientos que quedaron sin lugar y merecen un agradecimiento. */
  notSelectedParticipantIds: string[];
}

export interface ShiftLowStaffEvent {
  locationId: string;
  shiftId: string;
  shiftLabel: string;
  startsAt: Date;
  remaining: number;
  minCapacity: number;
  urgent: boolean;
  remainingParticipantNames: string[];
}

export interface ShiftCancelledEvent {
  locationId: string;
  shiftId: string;
  shiftLabel: string;
  reason: string;
  affectedParticipantIds: string[];
}

export interface QuestionAskedEvent {
  locationId: string;
  threadId: string;
  participantId: string;
  participantName: string;
  question: string;
}

export interface QuestionAnsweredEvent {
  locationId: string;
  threadId: string;
  participantId: string;
  supervisorId: string;
  supervisorName: string;
  answer: string;
}
