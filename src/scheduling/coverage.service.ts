import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  ActorType,
  AssignmentOrigin,
  AssignmentStatus,
  CoverageOfferStatus,
  CoverageRequestStatus,
  ParticipantStatus,
  Prisma,
  ShiftStatus,
} from '@prisma/client';
import { AUDIT_ACTIONS, AuditService } from '../audit/audit.service';
import { displayName, fullName } from '../common/names/person-name';
import { SettingsService } from '../common/settings/settings.service';
import { TimeService } from '../common/time/time.service';
import { DomainEventBus } from '../events/domain-event-bus';
import {
  CoverageClosedEvent,
  CoverageDecisionEvent,
  CoverageOfferEvent,
  CoverageOpenedEvent,
  DOMAIN_EVENTS,
} from '../events/domain-events';
import { PrismaService } from '../prisma/prisma.service';
import { OCCUPYING_STATUSES, ShiftsService } from './shifts.service';

export class CoverageUnavailableError extends BadRequestException {}

@Injectable()
export class CoverageService {
  private readonly logger = new Logger(CoverageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly time: TimeService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly shifts: ShiftsService,
    private readonly events: DomainEventBus,
  ) {}

  /**
   * Abre (o actualiza) la vacante de un turno con lugares libres.
   * Si ya había una vacante abierta se reutiliza y se ajusta el número de
   * lugares: dos bajas seguidas no deben generar dos publicaciones distintas.
   */
  async openForShift(shiftId: string, options: { urgent?: boolean } = {}): Promise<string | null> {
    const shift = await this.prisma.shift.findUniqueOrThrow({
      where: { id: shiftId },
      include: { location: true },
    });
    if (shift.status === ShiftStatus.CANCELLED) return null;
    if (shift.startsAt < this.time.now()) return null;

    const settings = this.settings.resolve(shift.location);
    const occupied = await this.shifts.countOccupied(shiftId);
    const freeSlots = shift.capacity - occupied;
    if (freeSlots <= 0) return null;

    const urgent =
      options.urgent ?? this.time.isWithinHours(shift.startsAt, settings.urgentWindowHours);

    // La vacante deja de aceptar ofrecimientos poco antes de que inicie el turno.
    const closesAt = new Date(
      shift.startsAt.getTime() - settings.coverageCloseHoursBeforeShift * 3_600_000,
    );

    const existing = await this.prisma.coverageRequest.findFirst({
      where: { shiftId, status: CoverageRequestStatus.OPEN },
    });

    const shiftLabel = this.shifts.label(shift, shift.location.timezone);
    const occupants = await this.prisma.assignment.findMany({
      where: { shiftId, status: { in: OCCUPYING_STATUSES } },
      select: { participantId: true },
    });

    if (existing) {
      const request = await this.prisma.coverageRequest.update({
        where: { id: existing.id },
        data: { slotsNeeded: freeSlots, urgent: existing.urgent || urgent, closesAt },
      });
      await this.emitOpened(request.id, shift, shiftLabel, freeSlots, request.urgent, occupants);
      return request.id;
    }

    const request = await this.prisma.coverageRequest.create({
      data: { shiftId, slotsNeeded: freeSlots, urgent, closesAt },
    });

    await this.audit.recordSystem(AUDIT_ACTIONS.COVERAGE_OPENED, 'CoverageRequest', request.id, {
      shiftId,
      shiftLabel,
      slotsNeeded: freeSlots,
      urgent,
    });

    this.logger.log(
      `Vacante abierta para ${shiftLabel}: ${freeSlots} lugar(es)${urgent ? ' (urgente)' : ''}`,
    );
    await this.emitOpened(request.id, shift, shiftLabel, freeSlots, urgent, occupants);
    return request.id;
  }

  /** Registra el ofrecimiento de un participante. No asigna: eso lo aprueba un encargado. */
  async offer(coverageRequestId: string, participantId: string): Promise<string> {
    const request = await this.prisma.coverageRequest.findUnique({
      where: { id: coverageRequestId },
      include: { shift: { include: { location: true } } },
    });
    if (!request) throw new NotFoundException('Esa vacante ya no existe');
    if (request.status !== CoverageRequestStatus.OPEN) {
      throw new CoverageUnavailableError('Ese turno ya fue cubierto');
    }
    if (request.closesAt < this.time.now()) {
      throw new CoverageUnavailableError('Ya pasó el plazo para ofrecerse a ese turno');
    }

    const participant = await this.prisma.participant.findUniqueOrThrow({
      where: { id: participantId },
    });
    if (participant.status !== ParticipantStatus.ACTIVE) {
      throw new CoverageUnavailableError('Tu registro no está activo');
    }

    const alreadyInShift = await this.prisma.assignment.findFirst({
      where: {
        shiftId: request.shiftId,
        participantId,
        status: { in: OCCUPYING_STATUSES },
      },
    });
    if (alreadyInShift) {
      throw new CoverageUnavailableError('Ya tienes lugar en ese turno');
    }

    const existingOffer = await this.prisma.coverageOffer.findUnique({
      where: { coverageRequestId_participantId: { coverageRequestId, participantId } },
    });
    if (existingOffer && existingOffer.status === CoverageOfferStatus.PENDING) {
      return existingOffer.id;
    }

    // Reutiliza la fila si antes se declinó: la persona puede volver a ofrecerse.
    const offer = await this.prisma.coverageOffer.upsert({
      where: { coverageRequestId_participantId: { coverageRequestId, participantId } },
      create: { coverageRequestId, participantId, offeredAt: this.time.now() },
      update: {
        status: CoverageOfferStatus.PENDING,
        offeredAt: this.time.now(),
        decidedAt: null,
        decidedById: null,
      },
    });

    const shiftLabel = this.shifts.label(request.shift, request.shift.location.timezone);

    await this.audit.record({
      actorType: ActorType.PARTICIPANT,
      actorId: participantId,
      actorName: fullName(participant),
      action: AUDIT_ACTIONS.COVERAGE_OFFERED,
      entity: 'CoverageOffer',
      entityId: offer.id,
      metadata: { coverageRequestId, shiftId: request.shiftId, shiftLabel },
    });

    const event: CoverageOfferEvent = {
      locationId: request.shift.locationId,
      coverageRequestId,
      offerId: offer.id,
      shiftId: request.shiftId,
      participantId,
      participantName: displayName(participant),
      shiftLabel,
      urgent: request.urgent,
    };
    await this.events.publish(DOMAIN_EVENTS.COVERAGE_OFFER_CREATED, event);

    return offer.id;
  }

  /**
   * Aprueba un ofrecimiento y sienta a la persona en el turno.
   *
   * Toda la operación va en una transacción que bloquea la fila del turno: si
   * dos encargados aprueban al mismo tiempo para el último lugar, uno gana y el
   * otro recibe un error claro en vez de producirse un sobrecupo.
   */
  async approve(
    offerId: string,
    decidedById: string | null,
    options: { automatic?: boolean } = {},
  ): Promise<void> {
    const automatic = options.automatic ?? false;

    const outcome = await this.prisma.$transaction(async (tx) => {
      const offer = await tx.coverageOffer.findUnique({
        where: { id: offerId },
        include: {
          participant: true,
          coverageRequest: { include: { shift: { include: { location: true } } } },
        },
      });
      if (!offer) throw new NotFoundException('Ese ofrecimiento ya no existe');
      if (offer.status !== CoverageOfferStatus.PENDING) {
        throw new CoverageUnavailableError('Ese ofrecimiento ya fue resuelto');
      }

      const request = offer.coverageRequest;
      const shift = request.shift;

      // Serializa a los aprobadores concurrentes sobre el mismo turno.
      await tx.$queryRaw`SELECT id FROM shifts WHERE id = ${shift.id} FOR UPDATE`;

      if (request.status !== CoverageRequestStatus.OPEN) {
        throw new CoverageUnavailableError('Ese turno ya fue cubierto');
      }

      const occupied = await tx.assignment.count({
        where: { shiftId: shift.id, status: { in: OCCUPYING_STATUSES } },
      });
      if (occupied >= shift.capacity) {
        throw new CoverageUnavailableError('Ese turno ya está completo');
      }

      await tx.assignment.upsert({
        where: {
          shiftId_participantId: { shiftId: shift.id, participantId: offer.participantId },
        },
        create: {
          shiftId: shift.id,
          participantId: offer.participantId,
          origin: AssignmentOrigin.COVERAGE,
          status: AssignmentStatus.ASSIGNED,
        },
        update: {
          origin: AssignmentOrigin.COVERAGE,
          status: AssignmentStatus.ASSIGNED,
          cancelledAt: null,
          cancelReason: null,
        },
      });

      await tx.coverageOffer.update({
        where: { id: offerId },
        data: {
          status: CoverageOfferStatus.APPROVED,
          decidedAt: this.time.now(),
          decidedById,
        },
      });

      const slotsFilled = request.slotsFilled + 1;
      const fulfilled = slotsFilled >= request.slotsNeeded || occupied + 1 >= shift.capacity;

      await tx.coverageRequest.update({
        where: { id: request.id },
        data: {
          slotsFilled,
          status: fulfilled ? CoverageRequestStatus.FULFILLED : CoverageRequestStatus.OPEN,
        },
      });

      // Al quedar cubierto, los demás ofrecimientos se cierran con agradecimiento.
      let notSelected: string[] = [];
      if (fulfilled) {
        const pending = await tx.coverageOffer.findMany({
          where: { coverageRequestId: request.id, status: CoverageOfferStatus.PENDING },
          select: { id: true, participantId: true },
        });
        notSelected = pending.map((item) => item.participantId);
        if (pending.length > 0) {
          await tx.coverageOffer.updateMany({
            where: { id: { in: pending.map((item) => item.id) } },
            data: {
              status: CoverageOfferStatus.DECLINED,
              decidedAt: this.time.now(),
              decidedById,
            },
          });
        }
      }

      await this.shifts.recomputeStatus(shift.id, tx);

      await this.audit.record(
        {
          actorType: automatic ? ActorType.SYSTEM : ActorType.SUPERVISOR,
          actorId: decidedById,
          action: automatic
            ? AUDIT_ACTIONS.COVERAGE_AUTO_APPROVED
            : AUDIT_ACTIONS.COVERAGE_APPROVED,
          entity: 'CoverageOffer',
          entityId: offerId,
          metadata: {
            shiftId: shift.id,
            participantId: offer.participantId,
            coverageRequestId: request.id,
            automatic,
          },
        },
        tx,
      );

      return { offer, shift, request, fulfilled, notSelected };
    });

    const shiftLabel = this.shifts.label(outcome.shift, outcome.shift.location.timezone);
    const decider = decidedById
      ? await this.prisma.participant.findUnique({ where: { id: decidedById } })
      : null;

    const decision: CoverageDecisionEvent = {
      locationId: outcome.shift.locationId,
      coverageRequestId: outcome.request.id,
      offerId,
      shiftId: outcome.shift.id,
      participantId: outcome.offer.participantId,
      participantName: displayName(outcome.offer.participant),
      shiftLabel,
      urgent: outcome.request.urgent,
      decidedById,
      decidedByName: decider ? displayName(decider) : null,
      automatic,
    };
    await this.events.publish(DOMAIN_EVENTS.COVERAGE_OFFER_APPROVED, decision);

    if (outcome.fulfilled) {
      const closed: CoverageClosedEvent = {
        locationId: outcome.shift.locationId,
        coverageRequestId: outcome.request.id,
        shiftId: outcome.shift.id,
        shiftLabel,
        notSelectedParticipantIds: outcome.notSelected,
      };
      await this.events.publish(DOMAIN_EVENTS.COVERAGE_FULFILLED, closed);
    }

    this.logger.log(
      `${displayName(outcome.offer.participant)} cubre ${shiftLabel}` +
        (automatic ? ' (aprobación automática por vencimiento del plazo)' : ''),
    );
  }

  /** Descarta un ofrecimiento concreto sin cerrar la vacante. */
  async decline(offerId: string, decidedById: string | null): Promise<void> {
    const offer = await this.prisma.coverageOffer.findUnique({
      where: { id: offerId },
      include: {
        participant: true,
        coverageRequest: { include: { shift: { include: { location: true } } } },
      },
    });
    if (!offer) throw new NotFoundException('Ese ofrecimiento ya no existe');
    if (offer.status !== CoverageOfferStatus.PENDING) return;

    await this.prisma.coverageOffer.update({
      where: { id: offerId },
      data: {
        status: CoverageOfferStatus.DECLINED,
        decidedAt: this.time.now(),
        decidedById,
      },
    });

    await this.audit.record({
      actorType: decidedById ? ActorType.SUPERVISOR : ActorType.SYSTEM,
      actorId: decidedById,
      action: AUDIT_ACTIONS.COVERAGE_DECLINED,
      entity: 'CoverageOffer',
      entityId: offerId,
    });

    const event: CoverageDecisionEvent = {
      locationId: offer.coverageRequest.shift.locationId,
      coverageRequestId: offer.coverageRequestId,
      offerId,
      shiftId: offer.coverageRequest.shiftId,
      participantId: offer.participantId,
      participantName: displayName(offer.participant),
      shiftLabel: this.shifts.label(
        offer.coverageRequest.shift,
        offer.coverageRequest.shift.location.timezone,
      ),
      urgent: offer.coverageRequest.urgent,
      decidedById,
      decidedByName: null,
      automatic: !decidedById,
    };
    await this.events.publish(DOMAIN_EVENTS.COVERAGE_OFFER_DECLINED, event);
  }

  /** Ofrecimientos pendientes de una vacante, en orden de llegada. */
  async pendingOffers(coverageRequestId: string) {
    return this.prisma.coverageOffer.findMany({
      where: { coverageRequestId, status: CoverageOfferStatus.PENDING },
      include: { participant: true },
      orderBy: { offeredAt: 'asc' },
    });
  }

  /** Vacantes abiertas a las que un participante puede ofrecerse. */
  async availableFor(participantId: string, locationId: string, limit = 10) {
    return this.prisma.coverageRequest.findMany({
      where: {
        status: CoverageRequestStatus.OPEN,
        closesAt: { gt: this.time.now() },
        shift: { locationId, status: { not: ShiftStatus.CANCELLED } },
        NOT: {
          shift: {
            assignments: {
              some: { participantId, status: { in: OCCUPYING_STATUSES } },
            },
          },
        },
      },
      include: { shift: true },
      orderBy: { shift: { startsAt: 'asc' } },
      take: limit,
    });
  }

  /** Cierra las vacantes cuyo plazo venció sin haberse cubierto. */
  async expireStale(): Promise<number> {
    const stale = await this.prisma.coverageRequest.findMany({
      where: { status: CoverageRequestStatus.OPEN, closesAt: { lt: this.time.now() } },
      include: { shift: { include: { location: true } } },
    });

    for (const request of stale) {
      await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.coverageRequest.update({
          where: { id: request.id },
          data: { status: CoverageRequestStatus.EXPIRED },
        });
        await tx.coverageOffer.updateMany({
          where: { coverageRequestId: request.id, status: CoverageOfferStatus.PENDING },
          data: { status: CoverageOfferStatus.EXPIRED, decidedAt: this.time.now() },
        });
        await this.audit.recordSystem(
          AUDIT_ACTIONS.COVERAGE_EXPIRED,
          'CoverageRequest',
          request.id,
          { shiftId: request.shiftId },
          tx,
        );
      });

      await this.events.publish(DOMAIN_EVENTS.COVERAGE_EXPIRED, {
        locationId: request.shift.locationId,
        coverageRequestId: request.id,
        shiftId: request.shiftId,
        shiftLabel: this.shifts.label(request.shift, request.shift.location.timezone),
        notSelectedParticipantIds: [],
      } satisfies CoverageClosedEvent);
    }

    if (stale.length > 0) {
      this.logger.log(`Se cerraron ${stale.length} vacante(s) por vencimiento del plazo`);
    }
    return stale.length;
  }

  private async emitOpened(
    coverageRequestId: string,
    shift: { id: string; locationId: string; startsAt: Date },
    shiftLabel: string,
    slotsNeeded: number,
    urgent: boolean,
    occupants: Array<{ participantId: string }>,
  ): Promise<void> {
    const event: CoverageOpenedEvent = {
      locationId: shift.locationId,
      coverageRequestId,
      shiftId: shift.id,
      slotsNeeded,
      urgent,
      shiftLabel,
      startsAt: shift.startsAt,
      excludeParticipantIds: occupants.map((item) => item.participantId),
    };
    await this.events.publish(DOMAIN_EVENTS.COVERAGE_OPENED, event);
  }
}
