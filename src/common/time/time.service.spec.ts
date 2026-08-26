import { DateTime } from 'luxon';
import { EVERY_WEEK, TimeService } from './time.service';

const TZ = 'America/Mexico_City';

describe('TimeService', () => {
  let service: TimeService;

  beforeEach(() => {
    service = new TimeService();
  });

  describe('ordinalOfMonth', () => {
    it('asigna el ordinal por bloques de siete días', () => {
      const cases: Array<[number, number]> = [
        [1, 1],
        [7, 1],
        [8, 2],
        [14, 2],
        [15, 3],
        [21, 3],
        [22, 4],
        [28, 4],
        [29, 5],
        [31, 5],
      ];
      for (const [day, expected] of cases) {
        const date = DateTime.fromObject({ year: 2026, month: 8, day }, { zone: TZ });
        expect(service.ordinalOfMonth(date)).toBe(expected);
      }
    });
  });

  describe('occurrencesInMonth', () => {
    it('devuelve todas las ocurrencias cuando no se filtra por ordinal', () => {
      // Agosto 2026 tiene sábados los días 1, 8, 15, 22 y 29.
      const days = service.occurrencesInMonth(2026, 8, 6, EVERY_WEEK, TZ).map((dt) => dt.day);
      expect(days).toEqual([1, 8, 15, 22, 29]);
    });

    it('encuentra el 5.º sábado cuando el mes lo tiene', () => {
      const fifth = service.occurrencesInMonth(2026, 8, 6, 5, TZ);
      expect(fifth).toHaveLength(1);
      expect(fifth[0].day).toBe(29);
    });

    it('no devuelve nada si el mes no tiene 5.º sábado', () => {
      // Septiembre 2026 solo tiene cuatro sábados: 5, 12, 19 y 26.
      expect(service.occurrencesInMonth(2026, 9, 6, 5, TZ)).toHaveLength(0);
    });

    it('encuentra el 5.º domingo en mayo de 2026', () => {
      const fifth = service.occurrencesInMonth(2026, 5, 0, 5, TZ);
      expect(fifth.map((dt) => dt.day)).toEqual([31]);
    });

    it('respeta los ordinales intermedios', () => {
      expect(service.occurrencesInMonth(2026, 9, 6, 1, TZ).map((d) => d.day)).toEqual([5]);
      expect(service.occurrencesInMonth(2026, 9, 6, 4, TZ).map((d) => d.day)).toEqual([26]);
    });

    it('devuelve los cinco días hábiles de una semana completa', () => {
      for (let weekday = 1; weekday <= 5; weekday += 1) {
        const days = service.occurrencesInMonth(2026, 9, weekday as 1, EVERY_WEEK, TZ);
        expect(days.length).toBeGreaterThanOrEqual(4);
        for (const day of days) {
          expect(service.weekday(day)).toBe(weekday);
        }
      }
    });
  });

  describe('weekday', () => {
    it('usa la convención 0 = domingo', () => {
      expect(service.weekday(DateTime.fromISO('2026-08-02', { zone: TZ }))).toBe(0);
      expect(service.weekday(DateTime.fromISO('2026-08-01', { zone: TZ }))).toBe(6);
      expect(service.weekday(DateTime.fromISO('2026-08-03', { zone: TZ }))).toBe(1);
    });
  });

  describe('toInstant', () => {
    it('resuelve la hora local del punto a UTC', () => {
      // México ya no aplica horario de verano: UTC-6 todo el año.
      const instant = service.toInstant('2026-08-27', 7 * 60, TZ);
      expect(instant.toISOString()).toBe('2026-08-27T13:00:00.000Z');
    });

    it('respeta el horario de verano de zonas que sí lo aplican', () => {
      const winter = service.toInstant('2026-01-15', 7 * 60, 'America/New_York');
      const summer = service.toInstant('2026-07-15', 7 * 60, 'America/New_York');
      expect(winter.toISOString()).toBe('2026-01-15T12:00:00.000Z');
      expect(summer.toISOString()).toBe('2026-07-15T11:00:00.000Z');
    });

    it('es la inversa de minutesOfDay', () => {
      const instant = service.toInstant('2026-08-27', 15 * 60, TZ);
      expect(service.minutesOfDay(instant, TZ)).toBe(15 * 60);
    });
  });

  describe('formato en español', () => {
    it('formatea minutos y rangos como los ve el participante', () => {
      expect(service.formatMinutes(420)).toBe('7:00');
      expect(service.formatMinutes(1020)).toBe('17:00');
      expect(service.formatRange(780, 900)).toBe('13:00 a 15:00');
    });

    it('formatea la etiqueta completa del turno', () => {
      const label = service.formatShiftLabel('2026-08-27', 420, 540, TZ);
      expect(label).toBe('jueves 27 de agosto, 7:00 a 9:00');
    });
  });

  describe('ventanas y urgencia', () => {
    beforeEach(() => {
      service.setClock(() => new Date('2026-08-26T18:00:00.000Z'));
    });

    it('detecta turnos dentro de la ventana de urgencia', () => {
      const enSeisHoras = new Date('2026-08-27T00:00:00.000Z');
      const enDosDias = new Date('2026-08-28T18:00:00.000Z');
      expect(service.isWithinHours(enSeisHoras, 24)).toBe(true);
      expect(service.isWithinHours(enDosDias, 24)).toBe(false);
    });

    it('no considera urgente un turno que ya pasó', () => {
      expect(service.isWithinHours(new Date('2026-08-26T10:00:00.000Z'), 24)).toBe(false);
    });

    it('evalúa franjas de guardia, incluidas las que cruzan medianoche', () => {
      expect(service.isMinuteWithinWindow(600, 480, 840)).toBe(true);
      expect(service.isMinuteWithinWindow(840, 480, 840)).toBe(false);
      expect(service.isMinuteWithinWindow(60, 1320, 120)).toBe(true);
      expect(service.isMinuteWithinWindow(600, 1320, 120)).toBe(false);
    });
  });

  describe('columnas de fecha', () => {
    it('conserva el día al ida y vuelta con una columna @db.Date', () => {
      const local = DateTime.fromISO('2026-08-29', { zone: TZ });
      const column = service.toDateColumn(local);
      expect(column.toISOString()).toBe('2026-08-29T00:00:00.000Z');
      expect(service.toLocalDate(column, TZ).toISODate()).toBe('2026-08-29');
    });
  });
});
