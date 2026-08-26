import { Injectable, NotFoundException } from '@nestjs/common';
import { ActorType, Participant, ParticipantRole, ParticipantStatus } from '@prisma/client';
import { AUDIT_ACTIONS, AuditService } from '../audit/audit.service';
import { PhoneService } from '../common/phone/phone.service';
import { TimeService } from '../common/time/time.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ParticipantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly phone: PhoneService,
    private readonly time: TimeService,
    private readonly audit: AuditService,
  ) {}

  /** Busca por teléfono aceptando las variantes del formato mexicano. */
  async findByPhone(e164: string): Promise<Participant | null> {
    return this.prisma.participant.findFirst({
      where: { phoneE164: { in: this.phone.lookupVariants(e164) } },
    });
  }

  /**
   * Punto de exhibición al que pertenece. Hoy hay uno solo, pero el sistema ya
   * lo resuelve por membresía para que agregar más no obligue a rehacer nada.
   */
  async primaryLocationId(participantId: string): Promise<string> {
    const membership = await this.prisma.locationMembership.findFirst({
      where: { participantId, active: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!membership) {
      throw new NotFoundException('El participante no pertenece a ningún punto de exhibición');
    }
    return membership.locationId;
  }

  /** Alta desde el panel o desde WhatsApp por un encargado. */
  async create(params: {
    fullName: string;
    phone: string;
    locationId: string;
    role?: ParticipantRole;
    createdById?: string | null;
  }): Promise<Participant> {
    const phoneE164 = this.phone.normalize(params.phone);

    const existing = await this.findByPhone(phoneE164);
    if (existing) {
      await this.prisma.locationMembership.upsert({
        where: {
          locationId_participantId: {
            locationId: params.locationId,
            participantId: existing.id,
          },
        },
        create: { locationId: params.locationId, participantId: existing.id },
        update: { active: true },
      });
      return existing;
    }

    const participant = await this.prisma.participant.create({
      data: {
        fullName: params.fullName.trim(),
        phoneE164,
        role: params.role ?? ParticipantRole.PARTICIPANT,
        memberships: { create: { locationId: params.locationId } },
      },
    });

    await this.audit.record({
      actorType: params.createdById ? ActorType.SUPERVISOR : ActorType.ADMIN,
      actorId: params.createdById ?? null,
      action: AUDIT_ACTIONS.PARTICIPANT_CREATED,
      entity: 'Participant',
      entityId: participant.id,
      after: { fullName: participant.fullName, phoneE164 },
    });

    return participant;
  }

  /**
   * Registra el consentimiento la primera vez que la persona escribe.
   * La política de Meta exige poder demostrar que aceptó recibir mensajes.
   */
  async ensureOptIn(participant: Participant): Promise<Participant> {
    if (participant.optInAt) return participant;

    const updated = await this.prisma.participant.update({
      where: { id: participant.id },
      data: { optInAt: this.time.now() },
    });

    await this.audit.record({
      actorType: ActorType.PARTICIPANT,
      actorId: participant.id,
      action: AUDIT_ACTIONS.PARTICIPANT_OPTED_IN,
      entity: 'Participant',
      entityId: participant.id,
    });

    return updated;
  }

  async setStatus(participantId: string, status: ParticipantStatus): Promise<void> {
    await this.prisma.participant.update({ where: { id: participantId }, data: { status } });
  }

  async setCoverageAlerts(participantId: string, enabled: boolean): Promise<void> {
    await this.prisma.participant.update({
      where: { id: participantId },
      data: { coverageAlerts: enabled },
    });
  }
}
