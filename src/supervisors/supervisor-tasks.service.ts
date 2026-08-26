import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  ActorType,
  CoverageOfferStatus,
  Prisma,
  SupervisorTask,
  SupervisorTaskStatus,
  SupervisorTaskType,
} from '@prisma/client';
import { AUDIT_ACTIONS, AuditService } from '../audit/audit.service';
import { SettingsService } from '../common/settings/settings.service';
import { TimeService } from '../common/time/time.service';
import { DomainEventBus } from '../events/domain-event-bus';
import { PrismaService } from '../prisma/prisma.service';

/** Aviso interno: hay una tarea que notificar a los encargados. */
export const SUPERVISOR_TASK_EVENTS = {
  CREATED: 'supervisor.task.created',
  ESCALATED: 'supervisor.task.escalated',
  RESOLVED: 'supervisor.task.resolved',
} as const;

export interface SupervisorTaskNotification {
  taskId: string;
  locationId: string;
  type: SupervisorTaskType;
  urgent: boolean;
  /** true cuando ya venció el plazo y se avisa también a quien no está de guardia. */
  escalated: boolean;
}

export interface CreateTaskParams {
  locationId: string;
  type: SupervisorTaskType;
  payload: Prisma.InputJsonValue;
  urgent?: boolean;
  shiftId?: string | null;
  coverageRequestId?: string | null;
  threadId?: string | null;
  requesterId?: string | null;
}

export class TaskAlreadyHandledError extends Error {
  constructor() {
    super('Esa solicitud ya fue atendida por otro encargado');
    this.name = 'TaskAlreadyHandledError';
  }
}

/**
 * Cola de trabajo de los encargados.
 *
 * Cada solicitud se difunde a todos los que están de guardia y el primero que la
 * toma la bloquea; a los demás se les avisa que ya fue atendida. Si nadie
 * responde antes del plazo, se escala y —cuando es urgente— el sistema resuelve
 * solo para no dejar el punto descubierto.
 */
@Injectable()
export class SupervisorTasksService {
  private readonly logger = new Logger(SupervisorTasksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly time: TimeService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: DomainEventBus,
  ) {}

  async create(params: CreateTaskParams): Promise<SupervisorTask> {
    const settings = await this.settings.forLocation(params.locationId);
    const urgent = params.urgent ?? false;
    const timeoutMinutes = urgent
      ? settings.urgentSupervisorTimeoutMinutes
      : settings.supervisorTimeoutMinutes;

    const task = await this.prisma.supervisorTask.create({
      data: {
        locationId: params.locationId,
        type: params.type,
        payload: params.payload,
        urgent,
        shiftId: params.shiftId ?? null,
        coverageRequestId: params.coverageRequestId ?? null,
        threadId: params.threadId ?? null,
        requesterId: params.requesterId ?? null,
        dueAt: new Date(this.time.now().getTime() + timeoutMinutes * 60_000),
      },
    });

    await this.audit.recordSystem(AUDIT_ACTIONS.TASK_CREATED, 'SupervisorTask', task.id, {
      type: params.type,
      urgent,
    });

    await this.events.publish(SUPERVISOR_TASK_EVENTS.CREATED, {
      taskId: task.id,
      locationId: task.locationId,
      type: task.type,
      urgent,
      escalated: false,
    } satisfies SupervisorTaskNotification);

    return task;
  }

  /**
   * Reserva la tarea para un encargado. El bloqueo de fila evita que dos
   * encargados que abren el mensaje a la vez crean ambos tenerla asignada.
   */
  async claim(taskId: string, supervisorId: string): Promise<SupervisorTask> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM supervisor_tasks WHERE id = ${taskId} FOR UPDATE`;

      const task = await tx.supervisorTask.findUnique({ where: { id: taskId } });
      if (!task) throw new NotFoundException('Esa solicitud ya no existe');

      if (task.status === SupervisorTaskStatus.CLAIMED && task.claimedById !== supervisorId) {
        throw new TaskAlreadyHandledError();
      }
      if (
        task.status === SupervisorTaskStatus.RESOLVED ||
        task.status === SupervisorTaskStatus.AUTO_RESOLVED ||
        task.status === SupervisorTaskStatus.CANCELLED
      ) {
        throw new TaskAlreadyHandledError();
      }

      const claimed = await tx.supervisorTask.update({
        where: { id: taskId },
        data: {
          status: SupervisorTaskStatus.CLAIMED,
          claimedById: supervisorId,
          claimedAt: this.time.now(),
        },
      });

      await this.audit.record(
        {
          actorType: ActorType.SUPERVISOR,
          actorId: supervisorId,
          action: AUDIT_ACTIONS.TASK_CLAIMED,
          entity: 'SupervisorTask',
          entityId: taskId,
        },
        tx,
      );

      return claimed;
    });
  }

  async resolve(
    taskId: string,
    supervisorId: string | null,
    resolution: string,
    options: { automatic?: boolean } = {},
  ): Promise<void> {
    const automatic = options.automatic ?? false;
    const task = await this.prisma.supervisorTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('Esa solicitud ya no existe');
    if (
      task.status === SupervisorTaskStatus.RESOLVED ||
      task.status === SupervisorTaskStatus.AUTO_RESOLVED
    ) {
      return;
    }

    await this.prisma.supervisorTask.update({
      where: { id: taskId },
      data: {
        status: automatic ? SupervisorTaskStatus.AUTO_RESOLVED : SupervisorTaskStatus.RESOLVED,
        resolvedById: supervisorId,
        resolvedAt: this.time.now(),
        resolution,
        autoResolvedAt: automatic ? this.time.now() : null,
      },
    });

    await this.audit.record({
      actorType: automatic ? ActorType.SYSTEM : ActorType.SUPERVISOR,
      actorId: supervisorId,
      action: automatic ? AUDIT_ACTIONS.TASK_AUTO_RESOLVED : AUDIT_ACTIONS.TASK_RESOLVED,
      entity: 'SupervisorTask',
      entityId: taskId,
      metadata: { resolution, type: task.type },
    });

    await this.events.publish(SUPERVISOR_TASK_EVENTS.RESOLVED, {
      taskId,
      locationId: task.locationId,
      type: task.type,
      urgent: task.urgent,
      escalated: false,
    } satisfies SupervisorTaskNotification);
  }

  /** Cancela una tarea que dejó de tener sentido (p. ej. la vacante ya se cubrió). */
  async cancelForCoverageRequest(coverageRequestId: string): Promise<void> {
    await this.prisma.supervisorTask.updateMany({
      where: {
        coverageRequestId,
        status: { in: [SupervisorTaskStatus.PENDING, SupervisorTaskStatus.CLAIMED] },
      },
      data: { status: SupervisorTaskStatus.CANCELLED, resolvedAt: this.time.now() },
    });
  }

  async pendingFor(locationId: string): Promise<SupervisorTask[]> {
    return this.prisma.supervisorTask.findMany({
      where: {
        locationId,
        status: { in: [SupervisorTaskStatus.PENDING, SupervisorTaskStatus.CLAIMED] },
      },
      orderBy: [{ urgent: 'desc' }, { createdAt: 'asc' }],
    });
  }

  /** Tarea activa ya existente para una vacante, para no duplicar avisos. */
  async findActiveForCoverage(
    coverageRequestId: string,
    type: SupervisorTaskType,
  ): Promise<SupervisorTask | null> {
    return this.prisma.supervisorTask.findFirst({
      where: {
        coverageRequestId,
        type,
        status: { in: [SupervisorTaskStatus.PENDING, SupervisorTaskStatus.CLAIMED] },
      },
    });
  }

  /** Refresca el contenido de una tarea ya abierta (p. ej. un ofrecimiento más). */
  async refreshPayload(
    taskId: string,
    payload: Prisma.InputJsonValue,
    urgent?: boolean,
  ): Promise<void> {
    await this.prisma.supervisorTask.update({
      where: { id: taskId },
      data: { payload, ...(urgent === undefined ? {} : { urgent }) },
    });
  }

  async findById(taskId: string): Promise<SupervisorTask | null> {
    return this.prisma.supervisorTask.findUnique({ where: { id: taskId } });
  }

  /** Tareas cuyo plazo ya venció, para escalar o resolver automáticamente. */
  async findDue(): Promise<SupervisorTask[]> {
    return this.prisma.supervisorTask.findMany({
      where: {
        status: { in: [SupervisorTaskStatus.PENDING, SupervisorTaskStatus.CLAIMED] },
        dueAt: { lt: this.time.now() },
      },
      orderBy: { dueAt: 'asc' },
    });
  }

  /** Vuelve a difundir la tarea, ahora también a los encargados fuera de guardia. */
  async escalate(task: SupervisorTask): Promise<void> {
    const settings = await this.settings.forLocation(task.locationId);
    await this.prisma.supervisorTask.update({
      where: { id: task.id },
      data: {
        notifiedCount: { increment: 1 },
        dueAt: new Date(this.time.now().getTime() + settings.supervisorTimeoutMinutes * 60_000),
      },
    });

    await this.audit.recordSystem(AUDIT_ACTIONS.TASK_ESCALATED, 'SupervisorTask', task.id, {
      type: task.type,
      notifiedCount: task.notifiedCount + 1,
    });

    await this.events.publish(SUPERVISOR_TASK_EVENTS.ESCALATED, {
      taskId: task.id,
      locationId: task.locationId,
      type: task.type,
      urgent: task.urgent,
      escalated: true,
    } satisfies SupervisorTaskNotification);

    this.logger.warn(
      `Solicitud ${task.id} (${task.type}) sin atender: se escala a todos los encargados`,
    );
  }

  /** Primer ofrecimiento pendiente de una vacante: el criterio de la auto-resolución. */
  async firstPendingOffer(coverageRequestId: string) {
    return this.prisma.coverageOffer.findFirst({
      where: { coverageRequestId, status: CoverageOfferStatus.PENDING },
      orderBy: { offeredAt: 'asc' },
      include: { participant: true },
    });
  }
}
