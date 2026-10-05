import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ActorType, ParticipantStatus } from '@prisma/client';
import { AUDIT_ACTIONS, AuditService } from '../audit/audit.service';
import { displayName, fullName, PADRON_ORDER } from '../common/names/person-name';
import { TimeService } from '../common/time/time.service';
import { PrismaService } from '../prisma/prisma.service';

export interface RecurringHolder {
  recurringId: string;
  participantId: string;
  name: string;
}

export interface RecurringSlot {
  templateId: string;
  weekday: number;
  /** 0 = todas las semanas; 1 a 5 = ordinal del mes (sábados y domingos). */
  weekOfMonth: number;
  startMinute: number;
  endMinute: number;
  range: string;
  capacity: number;
  holders: RecurringHolder[];
  freeSlots: number;
}

export interface Actor {
  id?: string | null;
  name?: string | null;
}

/**
 * Turnos fijos: quién atiende habitualmente cada franja.
 *
 * Son la base del calendario. Al materializar un mes, el generador sienta a
 * estos titulares en cada ocurrencia de su plantilla, así que capturarlos bien
 * es lo que hace que un mes nuevo nazca prácticamente completo en lugar de
 * vacío.
 *
 * La comprobación de cupo vive aquí y no en cada llamador: sentar más titulares
 * que lugares deja el turno permanentemente lleno y sin espacio para que nadie
 * cubra una baja.
 */
@Injectable()
export class RecurringAssignmentsService {
  private readonly logger = new Logger(RecurringAssignmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly time: TimeService,
    private readonly audit: AuditService,
  ) {}

  /** Todas las plantillas del punto con sus titulares. */
  async listByLocation(locationId: string): Promise<RecurringSlot[]> {
    const plantillas = await this.prisma.shiftTemplate.findMany({
      where: { locationId, active: true },
      include: {
        recurringAssignments: {
          where: { active: true },
          include: {
            participant: {
              select: {
                id: true,
                firstName: true,
                paternalSurname: true,
                maternalSurname: true,
                displayName: true,
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }, { weekOfMonth: 'asc' }],
    });

    return plantillas.map((plantilla) => ({
      templateId: plantilla.id,
      weekday: plantilla.weekday,
      weekOfMonth: plantilla.weekOfMonth,
      startMinute: plantilla.startMinute,
      endMinute: plantilla.endMinute,
      range: this.time.formatRange(plantilla.startMinute, plantilla.endMinute),
      capacity: plantilla.capacity,
      holders: plantilla.recurringAssignments.map((asignacion) => ({
        recurringId: asignacion.id,
        participantId: asignacion.participant.id,
        name: displayName(asignacion.participant),
      })),
      freeSlots: Math.max(0, plantilla.capacity - plantilla.recurringAssignments.length),
    }));
  }

  /**
   * Sienta a alguien como titular habitual de una franja.
   *
   * El bloqueo de fila sobre la plantilla serializa a dos administradores que
   * asignen a la vez: sin él, ambos podrían pasar la comprobación de cupo y
   * dejar el turno con más titulares que lugares.
   */
  async assign(templateId: string, participantId: string, actor: Actor = {}): Promise<void> {
    const resultado = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM shift_templates WHERE id = ${templateId} FOR UPDATE`;

      const plantilla = await tx.shiftTemplate.findUnique({ where: { id: templateId } });
      if (!plantilla) throw new NotFoundException('Ese turno ya no existe');

      const participante = await tx.participant.findUnique({ where: { id: participantId } });
      if (!participante) throw new NotFoundException('Ese participante ya no existe');
      if (participante.status !== ParticipantStatus.ACTIVE) {
        throw new BadRequestException(`${displayName(participante)} no está activo en el padrón`);
      }

      const existente = await tx.recurringAssignment.findUnique({
        where: { shiftTemplateId_participantId: { shiftTemplateId: templateId, participantId } },
      });
      if (existente?.active) {
        throw new BadRequestException(`${displayName(participante)} ya es titular de ese turno`);
      }

      const titulares = await tx.recurringAssignment.count({
        where: { shiftTemplateId: templateId, active: true },
      });
      if (titulares >= plantilla.capacity) {
        throw new BadRequestException(
          `Ese turno ya tiene ${titulares} titulares para ${plantilla.capacity} lugares`,
        );
      }

      // La fila se reutiliza si antes se quitó: el índice único lo exige.
      await tx.recurringAssignment.upsert({
        where: { shiftTemplateId_participantId: { shiftTemplateId: templateId, participantId } },
        create: { shiftTemplateId: templateId, participantId },
        update: { active: true },
      });

      await this.audit.record(
        {
          actorType: actor.id ? ActorType.ADMIN : ActorType.SYSTEM,
          actorId: actor.id ?? null,
          actorName: actor.name ?? null,
          action: AUDIT_ACTIONS.RECURRING_ASSIGNED,
          entity: 'RecurringAssignment',
          entityId: `${templateId}:${participantId}`,
          metadata: {
            participantName: fullName(participante),
            weekday: plantilla.weekday,
            startMinute: plantilla.startMinute,
            weekOfMonth: plantilla.weekOfMonth,
          },
        },
        tx,
      );

      return { nombre: displayName(participante) };
    });

    this.logger.log(`${resultado.nombre} queda como titular habitual del turno ${templateId}`);
  }

  /** Quita a alguien de un turno fijo. No toca los turnos ya generados. */
  async unassign(recurringId: string, actor: Actor = {}): Promise<void> {
    const asignacion = await this.prisma.recurringAssignment.findUnique({
      where: { id: recurringId },
      include: { participant: true, shiftTemplate: true },
    });
    if (!asignacion) throw new NotFoundException('Esa asignación ya no existe');
    if (!asignacion.active) return;

    await this.prisma.recurringAssignment.update({
      where: { id: recurringId },
      data: { active: false },
    });

    await this.audit.record({
      actorType: actor.id ? ActorType.ADMIN : ActorType.SYSTEM,
      actorId: actor.id ?? null,
      actorName: actor.name ?? null,
      action: AUDIT_ACTIONS.RECURRING_UNASSIGNED,
      entity: 'RecurringAssignment',
      entityId: recurringId,
      metadata: {
        participantName: fullName(asignacion.participant),
        weekday: asignacion.shiftTemplate.weekday,
        startMinute: asignacion.shiftTemplate.startMinute,
        weekOfMonth: asignacion.shiftTemplate.weekOfMonth,
      },
    });
  }

  /**
   * Quiénes pueden tomar esa franja: activos, del punto y que no sean ya
   * titulares. No se excluye a quien tenga otro turno fijo: alguien puede
   * atender dos franjas distintas.
   */
  async candidatesFor(templateId: string, locationId: string) {
    return this.prisma.participant.findMany({
      where: {
        status: ParticipantStatus.ACTIVE,
        memberships: { some: { locationId, active: true } },
        NOT: {
          recurringAssignments: { some: { shiftTemplateId: templateId, active: true } },
        },
      },
      select: {
        id: true,
        firstName: true,
        paternalSurname: true,
        maternalSurname: true,
        displayName: true,
      },
      orderBy: [...PADRON_ORDER],
    });
  }

  /** Cuántos turnos fijos tiene cada persona, para ver quién está sin asignar. */
  async countByParticipant(locationId: string): Promise<Map<string, number>> {
    const grupos = await this.prisma.recurringAssignment.groupBy({
      by: ['participantId'],
      where: { active: true, shiftTemplate: { locationId, active: true } },
      _count: true,
    });
    return new Map(grupos.map((grupo) => [grupo.participantId, grupo._count]));
  }
}
