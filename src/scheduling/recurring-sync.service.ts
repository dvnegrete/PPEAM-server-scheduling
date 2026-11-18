import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { TimeService } from '../common/time/time.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Actor } from './recurring-assignments.service';
import {
  GenerationResult,
  MonthPreview,
  ScheduleGeneratorService,
} from './schedule-generator.service';

/** Un mes posterior al actual que ya está generado. */
export interface UpcomingMonth {
  year: number;
  month: number;
  /** «diciembre 2026». */
  label: string;
}

/** Un mes próximo cuyo calendario todavía no refleja los turnos fijos. */
export interface PendingMonth extends UpcomingMonth, MonthPreview {}

export interface AppliedMonth extends UpcomingMonth {
  result: GenerationResult;
}

/**
 * Mantiene los meses próximos ya generados al día con los turnos fijos.
 *
 * Cambiar un turno fijo no toca el calendario por sí mismo: se aplica al volver
 * a generar el mes. Esta pieza dice qué meses tienen cambios sin aplicar y los
 * aplica todos de una vez, para hacerlo desde Turnos fijos sin ir mes por mes.
 *
 * Nunca crea un mes que no se haya generado ni toca el mes en curso: solo
 * trabaja sobre los meses posteriores que ya tienen turnos.
 */
@Injectable()
export class RecurringSyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly time: TimeService,
    private readonly generator: ScheduleGeneratorService,
  ) {}

  /** Los meses posteriores al actual que ya tienen turnos, en orden. */
  async upcomingGeneratedMonths(locationId: string): Promise<UpcomingMonth[]> {
    const location = await this.prisma.location.findUniqueOrThrow({ where: { id: locationId } });
    const nextMonth = this.time.nowInZone(location.timezone).startOf('month').plus({ months: 1 });
    const firstDay = DateTime.utc(nextMonth.year, nextMonth.month, 1);

    const dates = await this.prisma.shift.findMany({
      where: { locationId, date: { gte: this.time.toDateColumn(firstDay) } },
      select: { date: true },
      distinct: ['date'],
      orderBy: { date: 'asc' },
    });

    const months = new Map<string, UpcomingMonth>();
    for (const { date } of dates) {
      const year = date.getUTCFullYear();
      const month = date.getUTCMonth() + 1;
      const key = `${year}-${month}`;
      if (months.has(key)) continue;
      months.set(key, {
        year,
        month,
        label: DateTime.utc(year, month, 1).setLocale('es-MX').toFormat('LLLL yyyy'),
      });
    }
    return [...months.values()];
  }

  /**
   * Los meses próximos con algo por aplicar.
   *
   * Que un titular no quepa porque una cobertura ya llenó el lugar no cuenta
   * como pendiente: volver a generar no lo cambiaría.
   */
  async pendingChanges(locationId: string): Promise<PendingMonth[]> {
    const pending: PendingMonth[] = [];
    for (const upcoming of await this.upcomingGeneratedMonths(locationId)) {
      const preview = await this.generator.previewMonth(locationId, upcoming.year, upcoming.month);
      if (preview.toRelease + preview.toSeat + preview.shiftsToCreate > 0) {
        pending.push({ ...upcoming, ...preview });
      }
    }
    return pending;
  }

  /** Vuelve a generar cada mes próximo ya generado. */
  async applyToUpcomingMonths(locationId: string, actor: Actor = {}): Promise<AppliedMonth[]> {
    const applied: AppliedMonth[] = [];
    for (const upcoming of await this.upcomingGeneratedMonths(locationId)) {
      const result = await this.generator.generateMonth(
        locationId,
        upcoming.year,
        upcoming.month,
        actor,
      );
      applied.push({ ...upcoming, result });
    }
    return applied;
  }
}
