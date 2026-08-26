import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AssignmentStatus, Location, ShiftStatus } from '@prisma/client';
import { LocationSettings } from '../common/settings/location-settings';
import { SettingsService } from '../common/settings/settings.service';
import { TimeService } from '../common/time/time.service';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { MessageComposer } from './message-composer';
import { NotificationService } from './notification.service';
import { WA_TEMPLATES } from './templates';

/** Sábado y domingo se avisan con mucha más anticipación que el resto. */
function isWeekend(weekday: number): boolean {
  return weekday === 0 || weekday === 6;
}

/**
 * Recordatorios de turno con confirmación.
 *
 * Son la principal herramienta para adelantarse a las bajas: preguntar "¿podrás
 * cubrirlo?" con anticipación convierte una ausencia de último minuto en una
 * vacante con tiempo de sobra para cubrirse.
 *
 * De lunes a viernes salen el día anterior por la mañana. Sábado y domingo, una
 * semana antes, porque conseguir reemplazo para el fin de semana toma más.
 */
@Injectable()
export class RemindersService {
  private readonly logger = new Logger(RemindersService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly time: TimeService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationService,
    private readonly composer: MessageComposer,
    private readonly config: AppConfigService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'reminders' })
  async hourly(): Promise<void> {
    if (this.config.isTest || this.running) return;
    this.running = true;
    try {
      await this.dispatchDue();
    } catch (error) {
      this.logger.error(`Fallo al enviar recordatorios: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }

  /** Envía los recordatorios pendientes de todos los puntos activos. */
  async dispatchDue(): Promise<number> {
    const locations = await this.prisma.location.findMany({ where: { active: true } });
    let total = 0;
    for (const location of locations) {
      total += await this.dispatchForLocation(location);
    }
    return total;
  }

  async dispatchForLocation(location: Location): Promise<number> {
    const settings = this.settings.resolve(location);
    const localNow = this.time.nowInZone(location.timezone);

    // Antes de la hora configurada no se manda nada; después, se manda lo que
    // falte. Así un cron que se saltó una ejecución no pierde el recordatorio.
    if (localNow.hour < settings.reminderHourLocal) return 0;

    const weekdayTargets = this.targetDates(location, settings, false);
    const weekendTargets = this.targetDates(location, settings, true);

    let sent = 0;
    sent += await this.remindFor(location, weekdayTargets, false);
    sent += await this.remindFor(location, weekendTargets, true);

    if (sent > 0) {
      this.logger.log(`${location.name}: ${sent} recordatorio(s) enviado(s)`);
    }
    return sent;
  }

  /** Fecha objetivo: la de los turnos que toca recordar hoy. */
  private targetDates(location: Location, settings: LocationSettings, weekend: boolean): Date {
    const daysAhead = weekend
      ? settings.weekendReminderDaysAhead
      : settings.weekdayReminderDaysAhead;
    const target = this.time.nowInZone(location.timezone).plus({ days: daysAhead });
    return this.time.toDateColumn(target);
  }

  private async remindFor(location: Location, date: Date, weekend: boolean): Promise<number> {
    const assignments = await this.prisma.assignment.findMany({
      where: {
        // Quien ya confirmó no necesita que se le vuelva a preguntar.
        status: AssignmentStatus.ASSIGNED,
        remindedAt: null,
        shift: {
          locationId: location.id,
          date,
          status: { not: ShiftStatus.CANCELLED },
          startsAt: { gt: this.time.now() },
        },
      },
      include: { participant: true, shift: true },
    });

    let sent = 0;
    for (const assignment of assignments) {
      const shiftWeekday = this.time.weekday(assignment.shift.date, 'utc');
      if (isWeekend(shiftWeekday) !== weekend) continue;

      const label = this.time.formatShiftLabel(
        assignment.shift.date,
        assignment.shift.startMinute,
        assignment.shift.endMinute,
        location.timezone,
      );

      const delivered = await this.notifications.sendToParticipant(assignment.participant, {
        interactive: (to) =>
          this.composer.reminder(to, assignment.participant.fullName, label, assignment.id),
        template: {
          name: WA_TEMPLATES.RECORDATORIO_TURNO,
          params: [assignment.participant.fullName, label],
          buttonPayloads: [`CONFIRMO:${assignment.id}`, `NO_PODRE:${assignment.id}`],
        },
        // Aunque el cron corra varias veces, el recordatorio sale una sola vez.
        dedupeKey: `recordatorio:${assignment.id}`,
      });

      if (delivered) {
        await this.prisma.assignment.update({
          where: { id: assignment.id },
          data: { remindedAt: this.time.now() },
        });
        sent += 1;
      }
    }

    return sent;
  }
}
