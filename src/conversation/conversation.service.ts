import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Participant } from '@prisma/client';
import { greetingName } from '../common/names/person-name';
import { TimeService } from '../common/time/time.service';
import { MessageComposer } from '../messaging/message-composer';
import { ParticipantsService } from '../participants/participants.service';
import { PrismaService } from '../prisma/prisma.service';
import { AssignmentsService } from '../scheduling/assignments.service';
import { CoverageService } from '../scheduling/coverage.service';
import { ShiftsService } from '../scheduling/shifts.service';
import { SupervisorsService } from '../supervisors/supervisors.service';
import { ThreadsService } from '../threads/threads.service';
import { InboundService } from '../whatsapp/inbound.service';
import { OutboxService } from '../whatsapp/outbox.service';
import { OutgoingMessage } from '../whatsapp/types/message.types';
import {
  InboundEvent,
  InboundReplyEvent,
  InboundTextEvent,
  WHATSAPP_INBOUND_EVENT,
} from '../whatsapp/types/webhook.types';
import { ACTIONS, decodeReply } from './reply-ids';
import { SESSION_STATES, SessionService } from './session.service';
import { SupervisorFlow } from './supervisor.flow';

/**
 * Punto de entrada de todo lo que escribe la gente.
 *
 * Un solo número atiende a participantes y encargados; el rol decide qué opciones
 * ve cada quien. Para el participante la experiencia es siempre la misma
 * conversación, sin importar quién esté de guardia del otro lado.
 */
@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly participants: ParticipantsService,
    private readonly sessions: SessionService,
    private readonly composer: MessageComposer,
    private readonly outbox: OutboxService,
    private readonly inbound: InboundService,
    private readonly shifts: ShiftsService,
    private readonly assignments: AssignmentsService,
    private readonly coverage: CoverageService,
    private readonly supervisors: SupervisorsService,
    private readonly threads: ThreadsService,
    private readonly supervisorFlow: SupervisorFlow,
    private readonly time: TimeService,
  ) {}

  @OnEvent(WHATSAPP_INBOUND_EVENT)
  async handleInbound(event: InboundEvent): Promise<void> {
    try {
      await this.route(event);
      await this.inbound.markProcessed(event.waMessageId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error atendiendo ${event.waMessageId}: ${message}`);
      await this.inbound.markProcessed(event.waMessageId, message);
      // El error se le comunica a la persona: quedarse en silencio es lo peor
      // que puede hacer un sistema que existe para dar certeza.
      await this.reply(null, this.composer.notUnderstood(event.from));
    }
  }

  private async route(event: InboundEvent): Promise<void> {
    const participant = await this.participants.findByPhone(event.from);
    if (!participant) {
      await this.reply(null, this.composer.notRegistered(event.from));
      return;
    }

    await this.participants.ensureOptIn(participant);
    const locationId = await this.participants.primaryLocationId(participant.id);

    if (event.type === 'reply') {
      await this.handleReply(participant, locationId, event);
      return;
    }

    if (event.type === 'text') {
      await this.handleText(participant, locationId, event);
      return;
    }

    await this.reply(participant.id, this.composer.notUnderstood(participant.phoneE164));
  }

  // -------------------------------------------------------------------------
  // Texto libre
  // -------------------------------------------------------------------------

  private async handleText(
    participant: Participant,
    locationId: string,
    event: InboundTextEvent,
  ): Promise<void> {
    const session = await this.sessions.get(participant.id);

    if (session.state === SESSION_STATES.AWAITING_QUESTION) {
      await this.threads.open(participant.id, locationId, event.text);
      await this.sessions.clear(participant.id);
      await this.reply(participant.id, this.composer.questionReceived(participant.phoneE164));
      return;
    }

    if (session.state === SESSION_STATES.AWAITING_ANSWER && session.context.threadId) {
      await this.supervisorFlow.deliverAnswer(
        participant,
        session.context.threadId,
        session.context.taskId,
        event.text,
      );
      await this.sessions.clear(participant.id);
      return;
    }

    // Fase 2: aquí entra la interpretación con Claude del texto libre. Mientras
    // tanto, el menú evita que la persona se quede sin saber qué hacer.
    await this.showMenu(participant);
  }

  // -------------------------------------------------------------------------
  // Botones y listas
  // -------------------------------------------------------------------------

  private async handleReply(
    participant: Participant,
    locationId: string,
    event: InboundReplyEvent,
  ): Promise<void> {
    const { action, args } = decodeReply(event.replyId);

    switch (action) {
      case ACTIONS.MENU:
      case ACTIONS.CANCEL_ABORT:
        await this.sessions.clear(participant.id);
        return this.showMenu(participant);

      case ACTIONS.MY_SHIFTS:
        return this.showMyShifts(participant);

      case ACTIONS.CANCEL_PICK:
        return this.showShiftsToCancel(participant);

      case ACTIONS.CANCEL_SELECT:
        return this.askCancelConfirmation(participant, locationId, args[0]);

      case ACTIONS.CANCEL_CONFIRM:
        return this.doCancel(participant, args[0]);

      case ACTIONS.DECLINE_SHIFT:
        // Viene del recordatorio: se confirma antes de dar de baja.
        return this.askCancelConfirmation(participant, locationId, args[0]);

      case ACTIONS.CONFIRM_SHIFT:
        return this.doConfirm(participant, args[0]);

      case ACTIONS.COVER_LIST:
        return this.showAvailableCoverages(participant, locationId);

      case ACTIONS.COVER_OFFER:
        return this.doOffer(participant, args[0]);

      case ACTIONS.ASK:
        await this.sessions.set(participant.id, locationId, SESSION_STATES.AWAITING_QUESTION);
        return this.reply(participant.id, this.composer.askQuestion(participant.phoneE164));

      default:
        return this.supervisorFlow.handle(participant, locationId, action, args);
    }
  }

  // -------------------------------------------------------------------------
  // Acciones del participante
  // -------------------------------------------------------------------------

  private async showMenu(participant: Participant): Promise<void> {
    const isSupervisor = await this.supervisors.isSupervisor(participant.id);
    await this.reply(
      participant.id,
      this.composer.mainMenu(participant.phoneE164, greetingName(participant), isSupervisor),
    );
  }

  private async showMyShifts(participant: Participant): Promise<void> {
    const upcoming = await this.shifts.upcomingForParticipant(participant.id);
    const timezone = upcoming[0]?.shift.location.timezone ?? 'America/Mexico_City';

    await this.reply(
      participant.id,
      this.composer.myShifts(
        participant.phoneE164,
        upcoming.map((item) => ({ assignment: item, shift: item.shift })),
        timezone,
      ),
    );
  }

  private async showShiftsToCancel(participant: Participant): Promise<void> {
    const upcoming = await this.shifts.upcomingForParticipant(participant.id);
    const timezone = upcoming[0]?.shift.location.timezone ?? 'America/Mexico_City';

    await this.reply(
      participant.id,
      this.composer.pickShiftToCancel(
        participant.phoneE164,
        upcoming.map((item) => ({ assignment: item, shift: item.shift })),
        timezone,
      ),
    );
  }

  private async askCancelConfirmation(
    participant: Participant,
    locationId: string,
    assignmentId: string,
  ): Promise<void> {
    const assignment = await this.prisma.assignment.findUnique({
      where: { id: assignmentId },
      include: { shift: { include: { location: true } } },
    });
    if (!assignment || assignment.participantId !== participant.id) {
      await this.reply(participant.id, this.composer.notUnderstood(participant.phoneE164));
      return;
    }

    await this.sessions.set(participant.id, locationId, SESSION_STATES.AWAITING_CANCEL_CONFIRM, {
      assignmentId,
    });

    await this.reply(
      participant.id,
      this.composer.confirmCancellation(
        participant.phoneE164,
        this.shifts.label(assignment.shift, assignment.shift.location.timezone),
        assignmentId,
      ),
    );
  }

  private async doCancel(participant: Participant, assignmentId: string): Promise<void> {
    const assignment = await this.prisma.assignment.findUnique({
      where: { id: assignmentId },
      include: { shift: { include: { location: true } } },
    });
    if (!assignment || assignment.participantId !== participant.id) {
      await this.reply(participant.id, this.composer.notUnderstood(participant.phoneE164));
      return;
    }

    const label = this.shifts.label(assignment.shift, assignment.shift.location.timezone);
    const urgent = this.time.isWithinHours(assignment.shift.startsAt, 24);

    await this.assignments.cancel({ assignmentId });
    await this.sessions.clear(participant.id);

    await this.reply(
      participant.id,
      this.composer.cancellationDone(participant.phoneE164, label, urgent),
    );
  }

  private async doConfirm(participant: Participant, assignmentId: string): Promise<void> {
    await this.assignments.confirm(assignmentId);
    const assignment = await this.prisma.assignment.findUniqueOrThrow({
      where: { id: assignmentId },
      include: { shift: { include: { location: true } } },
    });

    await this.reply(
      participant.id,
      this.composer.taskResolvedByYou(
        participant.phoneE164,
        `Gracias por confirmar. Te esperamos en ${this.shifts.label(
          assignment.shift,
          assignment.shift.location.timezone,
        )}.`,
      ),
    );
  }

  private async showAvailableCoverages(
    participant: Participant,
    locationId: string,
  ): Promise<void> {
    const location = await this.prisma.location.findUniqueOrThrow({ where: { id: locationId } });
    const coverages = await this.coverage.availableFor(participant.id, locationId);

    await this.reply(
      participant.id,
      this.composer.availableCoverages(
        participant.phoneE164,
        coverages.map((item) => ({
          id: item.id,
          shift: item.shift,
          slotsNeeded: item.slotsNeeded - item.slotsFilled,
        })),
        location.timezone,
      ),
    );
  }

  private async doOffer(participant: Participant, coverageRequestId: string): Promise<void> {
    const request = await this.prisma.coverageRequest.findUnique({
      where: { id: coverageRequestId },
      include: { shift: { include: { location: true } } },
    });
    if (!request) {
      await this.reply(
        participant.id,
        this.composer.taskResolvedByYou(participant.phoneE164, 'Ese turno ya no está disponible.'),
      );
      return;
    }

    const label = this.shifts.label(request.shift, request.shift.location.timezone);

    try {
      await this.coverage.offer(coverageRequestId, participant.id);
      await this.reply(participant.id, this.composer.offerReceived(participant.phoneE164, label));
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : 'No se pudo registrar tu ofrecimiento';
      await this.reply(
        participant.id,
        this.composer.taskResolvedByYou(participant.phoneE164, detail),
      );
    }
  }

  /** Encola la respuesta. El destinatario ya viene dentro del mensaje. */
  private async reply(participantId: string | null, message: OutgoingMessage): Promise<void> {
    await this.outbox.enqueue(message, { participantId });
  }
}
