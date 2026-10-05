import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ActorType,
  MaritalStatus,
  Participant,
  ParticipantRole,
  ParticipantStatus,
} from '@prisma/client';
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

  // -------------------------------------------------------------------------
  // Estado civil y cónyuge
  // -------------------------------------------------------------------------

  /**
   * Actualiza estado civil y cónyuge en una sola operación coherente.
   *
   * Hay dos formas de registrar al cónyuge, y son excluyentes: si también
   * participa en los exhibidores se guarda la referencia —para poder usarla
   * después, por ejemplo al armar turnos— y si no participa solo se anota su
   * nombre, sin ningún otro dato.
   *
   * La referencia se mantiene **simétrica**: al casar a A con B, B queda casado
   * con A sin tener que capturarlo dos veces. Si alguno de los dos ya figuraba
   * casado con una tercera persona, la operación se rechaza en vez de dejar
   * vínculos cruzados.
   */
  async updateMarital(params: {
    participantId: string;
    maritalStatus: MaritalStatus;
    /** Cónyuge que también es participante. Excluyente con `spouseName`. */
    spouseParticipantId?: string | null;
    /** Nombre del cónyuge que no participa. Excluyente con `spouseParticipantId`. */
    spouseName?: string | null;
    actorId?: string | null;
    actorName?: string | null;
  }): Promise<Participant> {
    const { participantId, maritalStatus } = params;
    const spouseParticipantId = params.spouseParticipantId?.trim() || null;
    const spouseName = params.spouseName?.trim() || null;

    if (spouseParticipantId && spouseName) {
      throw new BadRequestException(
        'Indica al cónyuge del padrón o su nombre, no ambos: si está en el padrón, su nombre ya se conoce',
      );
    }
    if (spouseParticipantId === participantId) {
      throw new BadRequestException('Alguien no puede ser su propio cónyuge');
    }
    if (maritalStatus !== MaritalStatus.MARRIED && (spouseParticipantId || spouseName)) {
      throw new BadRequestException('Solo se registra cónyuge cuando el estado civil es «casado»');
    }

    return this.prisma.$transaction(async (tx) => {
      const actual = await tx.participant.findUnique({ where: { id: participantId } });
      if (!actual) throw new NotFoundException('Ese participante ya no existe');

      let nuevoConyuge: Participant | null = null;
      if (spouseParticipantId) {
        nuevoConyuge = await tx.participant.findUnique({ where: { id: spouseParticipantId } });
        if (!nuevoConyuge) throw new NotFoundException('El cónyuge indicado no está en el padrón');

        if (nuevoConyuge.spouseId && nuevoConyuge.spouseId !== participantId) {
          const tercero = await tx.participant.findUnique({
            where: { id: nuevoConyuge.spouseId },
            select: { fullName: true },
          });
          throw new BadRequestException(
            `${nuevoConyuge.fullName} ya figura casado con ${tercero?.fullName ?? 'otra persona'}`,
          );
        }
      }

      // El vínculo anterior se deshace por ambos lados antes de crear el nuevo;
      // si no, el otro quedaría apuntando a alguien que ya no le corresponde.
      if (actual.spouseId && actual.spouseId !== spouseParticipantId) {
        await tx.participant.update({
          where: { id: actual.spouseId },
          data: { spouseId: null },
        });
      }

      await tx.participant.update({
        where: { id: participantId },
        data: { maritalStatus, spouseId: null, spouseName: null },
      });

      if (nuevoConyuge) {
        await tx.participant.update({
          where: { id: nuevoConyuge.id },
          data: {
            spouseId: participantId,
            spouseName: null,
            // Un matrimonio lo es para los dos: si el cónyuge estaba sin
            // registrar, queda casado por la misma operación.
            maritalStatus: MaritalStatus.MARRIED,
          },
        });
      }

      const actualizado = await tx.participant.update({
        where: { id: participantId },
        data: {
          maritalStatus,
          spouseId: nuevoConyuge?.id ?? null,
          spouseName: nuevoConyuge ? null : spouseName,
        },
      });

      await this.audit.record(
        {
          actorType: params.actorId ? ActorType.ADMIN : ActorType.SYSTEM,
          actorId: params.actorId ?? null,
          actorName: params.actorName ?? null,
          action: nuevoConyuge ? AUDIT_ACTIONS.SPOUSE_LINKED : AUDIT_ACTIONS.PARTICIPANT_UPDATED,
          entity: 'Participant',
          entityId: participantId,
          before: {
            maritalStatus: actual.maritalStatus,
            spouseId: actual.spouseId,
            spouseName: actual.spouseName,
          },
          after: {
            maritalStatus,
            spouseId: actualizado.spouseId,
            spouseName: actualizado.spouseName,
          },
          metadata: {
            participantName: actual.fullName,
            spouseName: nuevoConyuge?.fullName ?? spouseName,
            spouseIsParticipant: Boolean(nuevoConyuge),
          },
        },
        tx,
      );

      return actualizado;
    });
  }

  /** Deshace el vínculo por ambos lados, conservando el estado civil. */
  async unlinkSpouse(
    participantId: string,
    actor?: { id?: string | null; name?: string | null },
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const actual = await tx.participant.findUnique({ where: { id: participantId } });
      if (!actual) throw new NotFoundException('Ese participante ya no existe');
      if (!actual.spouseId && !actual.spouseName) return;

      if (actual.spouseId) {
        await tx.participant.update({
          where: { id: actual.spouseId },
          data: { spouseId: null },
        });
      }
      await tx.participant.update({
        where: { id: participantId },
        data: { spouseId: null, spouseName: null },
      });

      await this.audit.record(
        {
          actorType: actor?.id ? ActorType.ADMIN : ActorType.SYSTEM,
          actorId: actor?.id ?? null,
          actorName: actor?.name ?? null,
          action: AUDIT_ACTIONS.SPOUSE_UNLINKED,
          entity: 'Participant',
          entityId: participantId,
          before: { spouseId: actual.spouseId, spouseName: actual.spouseName },
          metadata: { participantName: actual.fullName },
        },
        tx,
      );
    });
  }

  /**
   * Candidatos a cónyuge: del mismo punto, activos, sin pareja ya registrada.
   * Se incluye a quien ya está casado con esta persona para que el selector
   * pueda mostrar la selección vigente.
   */
  async spouseCandidates(participantId: string, locationId: string) {
    return this.prisma.participant.findMany({
      where: {
        id: { not: participantId },
        status: ParticipantStatus.ACTIVE,
        memberships: { some: { locationId, active: true } },
        OR: [
          // Libre: sin cónyuge del padrón y sin cónyuge anotado por nombre.
          // Quien ya está casado con alguien de fuera tampoco está disponible,
          // aunque su `spouseId` esté vacío.
          { AND: [{ spouseId: null }, { spouseName: null }] },
          // El cónyuge vigente, para que el selector muestre la selección actual.
          { spouseId: participantId },
        ],
      },
      select: { id: true, fullName: true },
      orderBy: { fullName: 'asc' },
    });
  }
}
