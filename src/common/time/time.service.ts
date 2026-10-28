import { Injectable } from '@nestjs/common';
import { DateTime, Interval } from 'luxon';

/** Día de la semana en la convención de `Date#getDay`: 0 = domingo ... 6 = sábado. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * Valor de `ShiftTemplate.weekOfMonth` que significa "todas las semanas del mes".
 * Ver la nota del esquema: se usa 0 en vez de NULL para que el índice UNIQUE
 * de las plantillas sí impida duplicados.
 */
export const EVERY_WEEK = 0;

export const WEEKDAY_NAMES_ES = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
] as const;

/**
 * Toda conversión entre hora local del punto de exhibición y UTC pasa por aquí.
 * Concentrarla en un solo lugar es deliberado: los turnos se definen en hora
 * local ("sábado 7:00") pero se comparan y ordenan en instantes absolutos, y
 * mezclar ambas representaciones es la fuente habitual de errores en sistemas
 * de horarios.
 */
@Injectable()
export class TimeService {
  /** Reloj inyectable: las pruebas y el simulador de tiempo lo sustituyen. */
  private clock: () => Date = () => new Date();

  setClock(clock: () => Date): void {
    this.clock = clock;
  }

  resetClock(): void {
    this.clock = () => new Date();
  }

  now(): Date {
    return this.clock();
  }

  nowInZone(timezone: string): DateTime {
    return DateTime.fromJSDate(this.now(), { zone: timezone });
  }

  /**
   * Ordinal de la ocurrencia del día de la semana dentro del mes.
   * El 1.º al 7.º día del mes son la 1.ª ocurrencia, el 8.º al 14.º la 2.ª, etc.
   * Así, el "5.º sábado" solo existe en meses cuyo primer sábado cae los días 1 o 2.
   */
  ordinalOfMonth(date: DateTime | Date, timezone?: string): number {
    const dt = this.toZoned(date, timezone);
    return Math.floor((dt.day - 1) / 7) + 1;
  }

  /** Día de la semana en convención 0=domingo (Luxon usa 1=lunes...7=domingo). */
  weekday(date: DateTime | Date, timezone?: string): Weekday {
    const dt = this.toZoned(date, timezone);
    return (dt.weekday % 7) as Weekday;
  }

  /**
   * Fechas de un mes en las que ocurre `weekday`, filtradas por ordinal.
   * `weekOfMonth = EVERY_WEEK` (0) devuelve todas las ocurrencias.
   */
  occurrencesInMonth(
    year: number,
    month: number,
    weekday: Weekday,
    weekOfMonth: number,
    timezone: string,
  ): DateTime[] {
    const first = DateTime.fromObject({ year, month, day: 1 }, { zone: timezone });
    if (!first.isValid) {
      throw new Error(`Mes inválido: ${year}-${month} en ${timezone}`);
    }

    const luxonWeekday = weekday === 0 ? 7 : weekday;
    const offset = (luxonWeekday - first.weekday + 7) % 7;

    const result: DateTime[] = [];
    for (let day = first.day + offset; day <= first.daysInMonth; day += 7) {
      const occurrence = first.set({ day });
      const ordinal = Math.floor((day - 1) / 7) + 1;
      if (weekOfMonth === EVERY_WEEK || ordinal === weekOfMonth) {
        result.push(occurrence.startOf('day'));
      }
    }
    return result;
  }

  /**
   * Convierte fecha local + minutos desde medianoche al instante absoluto.
   * Si esa hora local no existe por un salto de horario de verano, Luxon
   * devuelve el instante posterior al salto en vez de fallar.
   */
  toInstant(date: DateTime | Date | string, minuteOfDay: number, timezone: string): Date {
    const base = this.toLocalDate(date, timezone);
    return base.startOf('day').plus({ minutes: minuteOfDay }).toUTC().toJSDate();
  }

  /** Minutos desde medianoche en hora local del punto. */
  minutesOfDay(instant: Date, timezone: string): number {
    const dt = DateTime.fromJSDate(instant, { zone: timezone });
    return dt.hour * 60 + dt.minute;
  }

  /** "7:00" a partir de 420. */
  formatMinutes(minuteOfDay: number): string {
    const hour = Math.floor(minuteOfDay / 60);
    const minute = minuteOfDay % 60;
    return `${hour}:${String(minute).padStart(2, '0')}`;
  }

  /** "7:00 a 9:00" a partir de 420 y 540. */
  formatRange(startMinute: number, endMinute: number): string {
    return `${this.formatMinutes(startMinute)} a ${this.formatMinutes(endMinute)}`;
  }

  /** "jueves 27 de agosto" */
  formatDate(date: DateTime | Date | string, timezone: string): string {
    return this.toLocalDate(date, timezone).setLocale('es-MX').toFormat("cccc d 'de' LLLL");
  }

  /**
   * "07:00 a 09:00 am", o "11:00 am a 01:00 pm".
   *
   * El reloj de 12 horas es como se habla de los turnos en el grupo, así que es
   * el que usan los textos que se publican ahí. Con los dos extremos en la misma
   * mitad del día basta decirlo una vez al final; solo cuando el turno cruza el
   * mediodía hay que marcar los dos, que es donde se presta a confusión.
   */
  formatRange12(startMinute: number, endMinute: number): string {
    const inicio = this.hour12(startMinute);
    const fin = this.hour12(endMinute);
    return inicio.meridiano === fin.meridiano
      ? `${inicio.reloj} a ${fin.reloj} ${fin.meridiano}`
      : `${inicio.reloj} ${inicio.meridiano} a ${fin.reloj} ${fin.meridiano}`;
  }

  /** "Jue. 15" — el día como se lee en una lista de turnos. */
  formatDayShort(date: DateTime | Date | string, timezone: string): string {
    const fecha = this.toLocalDate(date, timezone).setLocale('es-MX');
    // Algunas versiones de Intl devuelven la abreviatura con punto y otras sin
    // él, así que se normaliza antes de añadirlo.
    const abreviatura = fecha.toFormat('ccc').replace(/\.$/, '');
    return `${abreviatura.charAt(0).toUpperCase()}${abreviatura.slice(1)}. ${fecha.day}`;
  }

  /** "07:00" + "am" a partir de 420. No usa Luxon: `a` da «a. m.» en es-MX. */
  private hour12(minuteOfDay: number): { reloj: string; meridiano: 'am' | 'pm' } {
    const hora24 = Math.floor(minuteOfDay / 60) % 24;
    const hora = hora24 % 12 === 0 ? 12 : hora24 % 12;
    return {
      reloj: `${String(hora).padStart(2, '0')}:${String(minuteOfDay % 60).padStart(2, '0')}`,
      meridiano: hora24 < 12 ? 'am' : 'pm',
    };
  }

  /** "jueves 27 de agosto, 7:00 a 9:00" — la etiqueta que ve el participante. */
  formatShiftLabel(
    date: DateTime | Date | string,
    startMinute: number,
    endMinute: number,
    timezone: string,
  ): string {
    return `${this.formatDate(date, timezone)}, ${this.formatRange(startMinute, endMinute)}`;
  }

  /** Horas que faltan para un instante; negativo si ya pasó. */
  hoursUntil(instant: Date): number {
    return Interval.fromDateTimes(
      DateTime.fromJSDate(this.now()),
      DateTime.fromJSDate(instant),
    ).length('hours');
  }

  /** ¿El instante cae dentro de las próximas `hours` horas (y aún no pasó)? */
  isWithinHours(instant: Date, hours: number): boolean {
    const diff = this.hoursUntil(instant);
    return diff >= 0 && diff <= hours;
  }

  /**
   * ¿`minuteOfDay` local cae dentro de la franja [start, end)?
   * Soporta franjas que cruzan la medianoche (p. ej. 22:00 a 2:00).
   */
  isMinuteWithinWindow(minuteOfDay: number, startMinute: number, endMinute: number): boolean {
    if (startMinute <= endMinute) {
      return minuteOfDay >= startMinute && minuteOfDay < endMinute;
    }
    return minuteOfDay >= startMinute || minuteOfDay < endMinute;
  }

  /** Fecha local (sin hora) tal como se guarda en la columna `date` de Shift. */
  toLocalDate(date: DateTime | Date | string, timezone: string): DateTime {
    if (DateTime.isDateTime(date)) {
      return date.setZone(timezone).startOf('day');
    }
    if (typeof date === 'string') {
      return DateTime.fromISO(date, { zone: timezone }).startOf('day');
    }
    // Las columnas `@db.Date` llegan como medianoche UTC: se leen en UTC para
    // no correrse un día al aplicar la zona del punto.
    return DateTime.fromJSDate(date, { zone: 'utc' })
      .setZone(timezone, {
        keepLocalTime: true,
      })
      .startOf('day');
  }

  /** Valor a guardar en una columna `@db.Date` (medianoche UTC del día local). */
  toDateColumn(date: DateTime): Date {
    return new Date(Date.UTC(date.year, date.month - 1, date.day));
  }

  private toZoned(date: DateTime | Date, timezone?: string): DateTime {
    if (DateTime.isDateTime(date)) {
      return timezone ? date.setZone(timezone) : date;
    }
    return timezone
      ? DateTime.fromJSDate(date, { zone: timezone })
      : DateTime.fromJSDate(date, { zone: 'utc' });
  }
}
