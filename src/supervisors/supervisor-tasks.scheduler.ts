import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupervisorTask, SupervisorTaskType } from '@prisma/client';
import { SettingsService } from '../common/settings/settings.service';
import { AppConfigService } from '../config/app-config.service';
import { CoverageService } from '../scheduling/coverage.service';
import { SupervisorTasksService } from './supervisor-tasks.service';

/**
 * Vigila los plazos de las solicitudes.
 *
 * Cuando nadie de guardia responde a tiempo, una solicitud urgente no puede
 * quedarse esperando: el sistema la resuelve por su cuenta y deja constancia,
 * porque el costo de un punto descubierto es mayor que el de una decisión
 * automática revisable. Las no urgentes solo se escalan al resto de encargados.
 */
@Injectable()
export class SupervisorTasksScheduler {
  private readonly logger = new Logger(SupervisorTasksScheduler.name);
  private running = false;

  constructor(
    private readonly tasks: SupervisorTasksService,
    private readonly coverage: CoverageService,
    private readonly settings: SettingsService,
    private readonly config: AppConfigService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'supervisor-tasks-due' })
  async handleDueTasks(): Promise<void> {
    if (this.config.isTest || this.running) return;
    this.running = true;
    try {
      await this.processDueTasks();
      await this.coverage.expireStale();
    } catch (error) {
      this.logger.error(`Fallo al procesar solicitudes vencidas: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }

  /** Público para poder ejercitarlo en pruebas y desde el simulador de tiempo. */
  async processDueTasks(): Promise<number> {
    const due = await this.tasks.findDue();
    let handled = 0;

    for (const task of due) {
      try {
        await this.handleTask(task);
        handled += 1;
      } catch (error) {
        this.logger.error(`No se pudo procesar la solicitud ${task.id}: ${String(error)}`);
      }
    }
    return handled;
  }

  private async handleTask(task: SupervisorTask): Promise<void> {
    switch (task.type) {
      case SupervisorTaskType.COVERAGE_APPROVAL:
        return this.handleCoverageApproval(task);

      case SupervisorTaskType.LOW_STAFF_ALERT:
        return this.handleLowStaff(task);

      case SupervisorTaskType.CANCELLATION_NOTICE:
        // Es solo informativa: nadie tiene que actuar, se cierra en silencio.
        return this.tasks.resolve(task.id, null, 'Aviso cerrado sin acción requerida', {
          automatic: true,
        });

      default:
        return this.tasks.escalate(task);
    }
  }

  private async handleCoverageApproval(task: SupervisorTask): Promise<void> {
    const settings = await this.settings.forLocation(task.locationId);

    if (!task.urgent || !settings.autoResolveUrgent) {
      return this.tasks.escalate(task);
    }
    if (!task.coverageRequestId) {
      return this.tasks.escalate(task);
    }

    const first = await this.tasks.firstPendingOffer(task.coverageRequestId);
    if (!first) {
      // Urgente pero sin nadie ofrecido: no hay nada que aprobar, solo insistir.
      return this.tasks.escalate(task);
    }

    await this.coverage.approve(first.id, null, { automatic: true });
    await this.tasks.resolve(
      task.id,
      null,
      `Aprobación automática por vencimiento del plazo: ${first.participant.fullName}`,
      { automatic: true },
    );

    this.logger.warn(
      `Nadie de guardia atendió la vacante ${task.coverageRequestId}; ` +
        `se aprobó automáticamente a ${first.participant.fullName} por orden de llegada`,
    );
  }

  private async handleLowStaff(task: SupervisorTask): Promise<void> {
    // Cancelar un turno es una decisión más grave que dejarlo con una persona,
    // así que el sistema nunca lo cancela solo: insiste con los encargados.
    await this.tasks.escalate(task);
  }
}
