import { Injectable, Logger } from '@nestjs/common';
import { ActorType, Participant, ParticipantRole, ParticipantStatus } from '@prisma/client';
import { AUDIT_ACTIONS, AuditService } from '../audit/audit.service';
import { TimeService, Weekday } from '../common/time/time.service';
import { PrismaService } from '../prisma/prisma.service';

/** Roles que pueden atender solicitudes de participantes. */
const SUPERVISOR_ROLES: ParticipantRole[] = [ParticipantRole.SUPERVISOR, ParticipantRole.ADMIN];

@Injectable()
export class SupervisorsService {
  private readonly logger = new Logger(SupervisorsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly time: TimeService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Encargados de guardia en este momento.
   *
   * Un encargado está de guardia si su franja habitual está vigente, salvo que
   * haya declarado lo contrario a mano. La declaración manual siempre gana
   * mientras no expire: permite decir "hoy sí puedo" fuera de horario o "ahora
   * no" dentro de él, que es justo la flexibilidad que hoy no existe.
   *
   * Nada de esto es visible para los participantes: ellos solo ven un número.
   */
  async onDutyNow(locationId: string): Promise<Participant[]> {
    const location = await this.prisma.location.findUniqueOrThrow({ where: { id: locationId } });
    const now = this.time.nowInZone(location.timezone);
    const weekday = this.time.weekday(now) as Weekday;
    const minuteOfDay = now.hour * 60 + now.minute;

    const supervisors = await this.prisma.participant.findMany({
      where: {
        role: { in: SUPERVISOR_ROLES },
        status: ParticipantStatus.ACTIVE,
        memberships: { some: { locationId, active: true } },
      },
      include: {
        presence: true,
        supervisorWindows: { where: { locationId, active: true, weekday } },
      },
    });

    return supervisors.filter((supervisor) => {
      const presence = supervisor.presence;
      const overrideActive =
        presence && (presence.until === null || presence.until > this.time.now());

      if (overrideActive) return presence.available;

      return supervisor.supervisorWindows.some((window) =>
        this.time.isMinuteWithinWindow(minuteOfDay, window.startMinute, window.endMinute),
      );
    });
  }

  /** Todos los encargados del punto, estén o no de guardia (para escalar). */
  async allSupervisors(locationId: string): Promise<Participant[]> {
    return this.prisma.participant.findMany({
      where: {
        role: { in: SUPERVISOR_ROLES },
        status: ParticipantStatus.ACTIVE,
        memberships: { some: { locationId, active: true } },
      },
    });
  }

  async isSupervisor(participantId: string): Promise<boolean> {
    const participant = await this.prisma.participant.findUnique({
      where: { id: participantId },
      select: { role: true },
    });
    return participant ? SUPERVISOR_ROLES.includes(participant.role) : false;
  }

  /** "Estoy disponible" — opcionalmente hasta una hora determinada. */
  async setAvailable(participantId: string, until?: Date | null): Promise<void> {
    await this.setPresence(participantId, true, until ?? null);
  }

  /** "No estoy disponible" — al expirar vuelven a regir sus franjas fijas. */
  async setUnavailable(participantId: string, until?: Date | null): Promise<void> {
    await this.setPresence(participantId, false, until ?? null);
  }

  /** Elimina la declaración manual: vuelve a mandar el horario habitual. */
  async clearPresence(participantId: string): Promise<void> {
    await this.prisma.supervisorPresence.deleteMany({ where: { participantId } });
  }

  private async setPresence(
    participantId: string,
    available: boolean,
    until: Date | null,
  ): Promise<void> {
    await this.prisma.supervisorPresence.upsert({
      where: { participantId },
      create: { participantId, available, until },
      update: { available, until },
    });

    await this.audit.record({
      actorType: ActorType.SUPERVISOR,
      actorId: participantId,
      action: available ? AUDIT_ACTIONS.SUPERVISOR_AVAILABLE : AUDIT_ACTIONS.SUPERVISOR_UNAVAILABLE,
      entity: 'SupervisorPresence',
      entityId: participantId,
      metadata: { until: until?.toISOString() ?? null },
    });

    this.logger.log(
      `Encargado ${participantId} se marcó ${available ? 'disponible' : 'no disponible'}` +
        (until ? ` hasta ${until.toISOString()}` : ''),
    );
  }

  /** Estado de guardia legible, para responderle al propio encargado. */
  async dutyStatus(participantId: string, locationId: string) {
    const location = await this.prisma.location.findUniqueOrThrow({ where: { id: locationId } });
    const presence = await this.prisma.supervisorPresence.findUnique({ where: { participantId } });
    const windows = await this.prisma.supervisorWindow.findMany({
      where: { participantId, locationId, active: true },
      orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }],
    });
    const onDuty = (await this.onDutyNow(locationId)).some((item) => item.id === participantId);

    return {
      onDuty,
      presence,
      windows,
      timezone: location.timezone,
      overrideActive: Boolean(
        presence && (presence.until === null || presence.until > this.time.now()),
      ),
    };
  }

  async addWindow(
    participantId: string,
    locationId: string,
    weekday: number,
    startMinute: number,
    endMinute: number,
  ) {
    return this.prisma.supervisorWindow.upsert({
      where: {
        participantId_locationId_weekday_startMinute: {
          participantId,
          locationId,
          weekday,
          startMinute,
        },
      },
      create: { participantId, locationId, weekday, startMinute, endMinute, active: true },
      update: { endMinute, active: true },
    });
  }

  async removeWindow(windowId: string): Promise<void> {
    await this.prisma.supervisorWindow.update({
      where: { id: windowId },
      data: { active: false },
    });
  }
}
