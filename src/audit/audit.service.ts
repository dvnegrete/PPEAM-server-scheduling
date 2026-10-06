import { Injectable, Logger } from '@nestjs/common';
import { ActorType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Acciones registradas. Son la base de los reportes, así que no se renombran a la ligera. */
export const AUDIT_ACTIONS = {
  SHIFT_GENERATED: 'shift.generated',
  SHIFT_CANCELLED: 'shift.cancelled',
  SHIFT_KEPT: 'shift.kept',
  ASSIGNMENT_CREATED: 'assignment.created',
  ASSIGNMENT_CONFIRMED: 'assignment.confirmed',
  ASSIGNMENT_CANCELLED: 'assignment.cancelled',
  COVERAGE_OPENED: 'coverage.opened',
  COVERAGE_BROADCAST: 'coverage.broadcast',
  COVERAGE_OFFERED: 'coverage.offered',
  COVERAGE_APPROVED: 'coverage.approved',
  COVERAGE_DECLINED: 'coverage.declined',
  COVERAGE_AUTO_APPROVED: 'coverage.auto_approved',
  COVERAGE_EXPIRED: 'coverage.expired',
  TASK_CREATED: 'task.created',
  TASK_CLAIMED: 'task.claimed',
  TASK_RESOLVED: 'task.resolved',
  TASK_AUTO_RESOLVED: 'task.auto_resolved',
  TASK_ESCALATED: 'task.escalated',
  SUPERVISOR_AVAILABLE: 'supervisor.available',
  SUPERVISOR_UNAVAILABLE: 'supervisor.unavailable',
  PARTICIPANT_CREATED: 'participant.created',
  PARTICIPANT_UPDATED: 'participant.updated',
  /**
   * El cambio de número tiene su propia acción porque es el que más cosas
   * arrastra —la ventana de servicio, los envíos pendientes, la identidad en
   * WhatsApp— y mezclado en `participant.updated` no se distinguiría de un
   * cambio de congregación al revisar los reportes.
   */
  PARTICIPANT_PHONE_CHANGED: 'participant.phone_changed',
  /** Pausa o baja: conviene poder listar quién dejó de participar y cuándo. */
  PARTICIPANT_STATUS_CHANGED: 'participant.status_changed',
  PARTICIPANT_OPTED_IN: 'participant.opted_in',
  SPOUSE_LINKED: 'participant.spouse_linked',
  SPOUSE_UNLINKED: 'participant.spouse_unlinked',
  THREAD_OPENED: 'thread.opened',
  THREAD_ANSWERED: 'thread.answered',
  THREAD_CLOSED: 'thread.closed',
  RECURRING_ASSIGNED: 'recurring.assigned',
  RECURRING_UNASSIGNED: 'recurring.unassigned',
  IMPORT_RUN: 'import.run',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export interface AuditEntry {
  actorType: ActorType;
  actorId?: string | null;
  actorName?: string | null;
  /** Preferir las constantes de AUDIT_ACTIONS; se acepta texto libre por extensibilidad. */
  action: string;
  entity: string;
  entityId?: string | null;
  before?: Prisma.InputJsonValue | null;
  after?: Prisma.InputJsonValue | null;
  metadata?: Prisma.InputJsonValue | null;
}

/**
 * Bitácora de solo inserción. Recibe opcionalmente un cliente de transacción
 * para que el registro se guarde junto con el cambio que documenta.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry, tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx ?? this.prisma;
    try {
      await client.auditLog.create({
        data: {
          actorType: entry.actorType,
          actorId: entry.actorId ?? null,
          actorName: entry.actorName ?? null,
          action: entry.action,
          entity: entry.entity,
          entityId: entry.entityId ?? null,
          before: entry.before ?? Prisma.DbNull,
          after: entry.after ?? Prisma.DbNull,
          metadata: entry.metadata ?? Prisma.DbNull,
        },
      });
    } catch (error) {
      // Fuera de transacción, un fallo de auditoría no debe tumbar la operación
      // de negocio; dentro de una, sí se propaga para no dejar cambios sin rastro.
      if (tx) throw error;
      this.logger.error(
        `No se pudo registrar en bitácora la acción ${entry.action}: ${String(error)}`,
      );
    }
  }

  /** Atajo para acciones ejecutadas por el propio sistema (cron, auto-resolución). */
  async recordSystem(
    action: string,
    entity: string,
    entityId: string | null,
    metadata?: Prisma.InputJsonValue,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    await this.record({ actorType: ActorType.SYSTEM, action, entity, entityId, metadata }, tx);
  }
}
