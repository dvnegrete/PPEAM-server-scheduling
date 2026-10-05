import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { LocationMembership, ParticipantRole, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface MembershipOptions {
  role?: ParticipantRole;
  coverageAlerts?: boolean;
  /** Fuerza este punto como el principal, aunque la persona ya tenga otro. */
  makePrimary?: boolean;
}

/**
 * Pertenencia de las personas a los puntos de exhibición.
 *
 * La relación es muchos a muchos: alguien puede atender varios puntos y cada
 * punto tiene mucha gente. Este servicio es el dueño de las dos invariantes que
 * esa relación necesita para no dejar al sistema sin saber qué responder:
 *
 *   1. Quien tiene al menos un punto activo tiene exactamente uno marcado como
 *      principal. Es el que se asume cuando la persona escribe sin decir de cuál
 *      habla.
 *   2. El rol y la preferencia de avisos son del vínculo, no de la persona: se
 *      puede ser encargado en un punto y solo participante en otro.
 *
 * La primera también la garantiza la base con un índice único parcial, así que
 * cualquier intento de dejar dos principales falla en lugar de pasar inadvertido.
 */
@Injectable()
export class MembershipsService {
  private readonly logger = new Logger(MembershipsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Da de alta a una persona en un punto, o reactiva su vínculo.
   * La primera membresía de alguien queda como principal: hace falta que haya
   * una por omisión desde el primer momento.
   */
  async join(
    participantId: string,
    locationId: string,
    options: MembershipOptions = {},
    tx?: Prisma.TransactionClient,
  ): Promise<LocationMembership> {
    const ejecutar = async (client: Prisma.TransactionClient) => {
      const activas = await client.locationMembership.count({
        where: { participantId, active: true },
      });
      const existente = await client.locationMembership.findUnique({
        where: { locationId_participantId: { locationId, participantId } },
      });

      const esPrimera = activas === 0 || (activas === 1 && existente?.active === true);
      const principal = options.makePrimary === true || esPrimera;

      if (principal) {
        // El índice único parcial no admite dos principales, así que la anterior
        // se baja antes de subir esta.
        await client.locationMembership.updateMany({
          where: { participantId, isPrimary: true, NOT: { locationId } },
          data: { isPrimary: false },
        });
      }

      return client.locationMembership.upsert({
        where: { locationId_participantId: { locationId, participantId } },
        create: {
          locationId,
          participantId,
          role: options.role ?? ParticipantRole.PARTICIPANT,
          coverageAlerts: options.coverageAlerts ?? true,
          isPrimary: principal,
        },
        update: {
          active: true,
          ...(options.role !== undefined ? { role: options.role } : {}),
          ...(options.coverageAlerts !== undefined
            ? { coverageAlerts: options.coverageAlerts }
            : {}),
          ...(principal ? { isPrimary: true } : {}),
        },
      });
    };

    return tx ? ejecutar(tx) : this.prisma.$transaction(ejecutar);
  }

  /**
   * Da de baja el vínculo con un punto.
   * Si era el principal y quedan otros, se promueve el más antiguo: dejar a
   * alguien sin punto por omisión haría que el sistema no supiera a qué punto
   * referir lo que escriba.
   */
  async leave(participantId: string, locationId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const membresia = await tx.locationMembership.findUnique({
        where: { locationId_participantId: { locationId, participantId } },
      });
      if (!membresia || !membresia.active) return;

      await tx.locationMembership.update({
        where: { id: membresia.id },
        data: { active: false, isPrimary: false },
      });

      if (!membresia.isPrimary) return;

      const sucesora = await tx.locationMembership.findFirst({
        where: { participantId, active: true },
        orderBy: { createdAt: 'asc' },
      });
      if (sucesora) {
        await tx.locationMembership.update({
          where: { id: sucesora.id },
          data: { isPrimary: true },
        });
        this.logger.log(
          `El punto principal de ${participantId} pasó a ${sucesora.locationId} al dejar ${locationId}`,
        );
      }
    });
  }

  /** Cambia cuál es el punto que se asume por omisión. */
  async setPrimary(participantId: string, locationId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const membresia = await tx.locationMembership.findUnique({
        where: { locationId_participantId: { locationId, participantId } },
      });
      if (!membresia?.active) {
        throw new NotFoundException('Esa persona no pertenece a ese punto de exhibición');
      }

      await tx.locationMembership.updateMany({
        where: { participantId, isPrimary: true },
        data: { isPrimary: false },
      });
      await tx.locationMembership.update({
        where: { id: membresia.id },
        data: { isPrimary: true },
      });
    });
  }

  /** Rol de una persona en un punto concreto. */
  async setRole(participantId: string, locationId: string, role: ParticipantRole): Promise<void> {
    await this.requireMembership(participantId, locationId);
    await this.prisma.locationMembership.update({
      where: { locationId_participantId: { locationId, participantId } },
      data: { role },
    });
  }

  /** Si quiere avisos de vacantes de un punto concreto. */
  async setCoverageAlerts(
    participantId: string,
    locationId: string,
    enabled: boolean,
  ): Promise<void> {
    await this.requireMembership(participantId, locationId);
    await this.prisma.locationMembership.update({
      where: { locationId_participantId: { locationId, participantId } },
      data: { coverageAlerts: enabled },
    });
  }

  /** Puntos de una persona, con su rol en cada uno. El principal va primero. */
  async locationsOf(participantId: string) {
    return this.prisma.locationMembership.findMany({
      where: { participantId, active: true },
      include: { location: { select: { id: true, name: true, timezone: true } } },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
  }

  async membershipIn(
    participantId: string,
    locationId: string,
  ): Promise<LocationMembership | null> {
    return this.prisma.locationMembership.findUnique({
      where: { locationId_participantId: { locationId, participantId } },
    });
  }

  /**
   * Punto que se asume cuando alguien escribe sin decir de cuál habla.
   *
   * Normalmente es el marcado como principal. El respaldo por antigüedad cubre a
   * quien quedara sin marca por una escritura directa a la base: es preferible
   * responderle por su punto más antiguo que negarle el servicio.
   */
  async primaryLocationId(participantId: string): Promise<string> {
    const principal = await this.prisma.locationMembership.findFirst({
      where: { participantId, active: true, isPrimary: true },
    });
    if (principal) return principal.locationId;

    const masAntigua = await this.prisma.locationMembership.findFirst({
      where: { participantId, active: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!masAntigua) {
      throw new NotFoundException('El participante no pertenece a ningún punto de exhibición');
    }

    this.logger.warn(
      `${participantId} no tenía punto principal; se usa ${masAntigua.locationId} por antigüedad`,
    );
    return masAntigua.locationId;
  }

  private async requireMembership(participantId: string, locationId: string): Promise<void> {
    const membresia = await this.membershipIn(participantId, locationId);
    if (!membresia?.active) {
      throw new NotFoundException('Esa persona no pertenece a ese punto de exhibición');
    }
  }
}
