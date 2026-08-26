import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SettingsService } from '../common/settings/settings.service';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { ScheduleGeneratorService } from './schedule-generator.service';

/**
 * Mantenimiento diario del calendario.
 *
 * Materializar los turnos por adelantado permite que la gente consulte y cancele
 * con semanas de anticipación, y es lo que hace posible el recordatorio de fin de
 * semana con siete días de aviso.
 */
@Injectable()
export class ScheduleMaintenanceService {
  private readonly logger = new Logger(ScheduleMaintenanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly generator: ScheduleGeneratorService,
    private readonly settings: SettingsService,
    private readonly config: AppConfigService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'schedule-horizon' })
  async extendHorizon(): Promise<void> {
    if (this.config.isTest) return;
    await this.run();
  }

  async run(): Promise<void> {
    const locations = await this.prisma.location.findMany({ where: { active: true } });

    for (const location of locations) {
      const settings = this.settings.resolve(location);
      try {
        await this.generator.generateHorizon(location.id, settings.scheduleHorizonMonths);
      } catch (error) {
        this.logger.error(
          `No se pudo extender el calendario de ${location.name}: ${String(error)}`,
        );
      }
    }
  }
}
