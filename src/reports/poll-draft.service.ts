import { Injectable } from '@nestjs/common';
import { ShiftStatus } from '@prisma/client';
import { TimeService } from '../common/time/time.service';
import { PrismaService } from '../prisma/prisma.service';
import { OCCUPYING_STATUSES } from '../scheduling/shifts.service';

/** Límite de opciones de una encuesta de WhatsApp. */
export const WHATSAPP_POLL_MAX_OPTIONS = 12;

/**
 * Cuánta gente se pide, en palabras. El cupo de un turno es de unas pocas
 * personas, así que la tabla cubre el rango real y cae al número si algún día
 * se amplía.
 */
const PARTICIPANTES_EN_PALABRAS = ['Cero', 'Un(a)', 'Dos', 'Tres', 'Cuatro', 'Cinco', 'Seis'];

/** Qué turnos entran en la convocatoria. */
export type PollLevel = 'cupo' | 'minimo';

export interface PollOption {
  shiftId: string;
  /** Línea lista para pegar como opción de la encuesta. */
  text: string;
  date: string;
  missing: number;
}

export interface PollDraft {
  /** Pregunta de la encuesta, ya redactada con el rango elegido. */
  question: string;
  options: PollOption[];
  /** Texto completo, por si prefieren publicarlo como mensaje normal. */
  plainText: string;
  /** Necesidades encontradas en el rango, antes de recortar a 12. */
  totalNeeded: number;
  /** true cuando hubo que dejar fuera turnos por el límite de WhatsApp. */
  truncated: boolean;
  maxOptions: number;
}

/**
 * Arma el texto de la encuesta que el administrador publica en el grupo.
 *
 * El sistema no publica ni lee esa encuesta: solo evita que alguien tenga que
 * revisar el calendario turno por turno y transcribir a mano lo que falta, que es
 * donde hoy se pierde tiempo y se cuelan errores.
 */
@Injectable()
export class PollDraftService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly time: TimeService,
  ) {}

  async build(
    locationId: string,
    from: Date,
    to: Date,
    level: PollLevel = 'cupo',
  ): Promise<PollDraft> {
    const location = await this.prisma.location.findUniqueOrThrow({ where: { id: locationId } });

    const shifts = await this.prisma.shift.findMany({
      where: {
        locationId,
        startsAt: { gte: from, lte: to },
        status: { not: ShiftStatus.CANCELLED },
      },
      include: {
        assignments: { where: { status: { in: OCCUPYING_STATUSES } }, select: { id: true } },
      },
      orderBy: [{ date: 'asc' }, { startMinute: 'asc' }],
    });

    // Con nivel «cupo» se convoca para dejar el turno completo; con «mínimo», solo
    // cuando está por debajo de lo que se considera operable.
    const umbral = (capacity: number): number =>
      level === 'minimo' ? location.minCapacity : capacity;

    const necesidades = shifts
      .map((shift) => {
        const ocupados = shift.assignments.length;
        const faltan = Math.max(0, umbral(shift.capacity) - ocupados);
        return { shift, faltan };
      })
      .filter((item) => item.faltan > 0);

    const options: PollOption[] = necesidades
      .slice(0, WHATSAPP_POLL_MAX_OPTIONS)
      .map(({ shift, faltan }) => ({
        shiftId: shift.id,
        date: shift.date.toISOString().slice(0, 10),
        missing: faltan,
        text: this.optionText(shift, faltan, location.timezone),
      }));

    const question = this.questionText(from, to, location.timezone);

    return {
      question,
      options,
      plainText: this.plainText(question, options),
      totalNeeded: necesidades.length,
      truncated: necesidades.length > WHATSAPP_POLL_MAX_OPTIONS,
      maxOptions: WHATSAPP_POLL_MAX_OPTIONS,
    };
  }

  /** «Jue. 15 de *11:00 am a 01:00 pm* (Un(a) Participante)» */
  private optionText(
    shift: { date: Date; startMinute: number; endMinute: number },
    faltan: number,
    timezone: string,
  ): string {
    const fecha = this.time.toLocalDate(shift.date, timezone).setLocale('es-MX');
    // Algunas versiones de Intl devuelven la abreviatura con punto y otras sin
    // él, así que se normaliza antes de añadirlo.
    const abreviatura = fecha.toFormat('ccc').replace(/\.$/, '');
    const dia = `${abreviatura.charAt(0).toUpperCase()}${abreviatura.slice(1)}.`;
    const horario = this.rango12h(shift.startMinute, shift.endMinute);
    return `${dia} ${fecha.day} de *${horario}* (${this.cuantosFaltan(faltan)})`;
  }

  /**
   * «07:00 a 09:00 am» o «11:00 am a 01:00 pm».
   *
   * Con los dos extremos en la misma mitad del día basta decirlo una vez al
   * final; solo cuando el turno cruza el mediodía hay que marcar los dos, que es
   * donde se presta a confusión.
   */
  private rango12h(startMinute: number, endMinute: number): string {
    const inicio = this.hora12(startMinute);
    const fin = this.hora12(endMinute);
    return inicio.meridiano === fin.meridiano
      ? `${inicio.reloj} a ${fin.reloj} ${fin.meridiano}`
      : `${inicio.reloj} ${inicio.meridiano} a ${fin.reloj} ${fin.meridiano}`;
  }

  /** «07:00» + «am» a partir de 420. No usa Luxon: `a` da «a. m.» en es-MX. */
  private hora12(minuteOfDay: number): { reloj: string; meridiano: 'am' | 'pm' } {
    const hora24 = Math.floor(minuteOfDay / 60) % 24;
    const hora = hora24 % 12 === 0 ? 12 : hora24 % 12;
    return {
      reloj: `${String(hora).padStart(2, '0')}:${String(minuteOfDay % 60).padStart(2, '0')}`,
      meridiano: hora24 < 12 ? 'am' : 'pm',
    };
  }

  /** «Un(a) Participante», «Dos Participantes»… */
  private cuantosFaltan(faltan: number): string {
    const palabra = PARTICIPANTES_EN_PALABRAS[faltan] ?? String(faltan);
    return `${palabra} ${faltan === 1 ? 'Participante' : 'Participantes'}`;
  }

  private questionText(from: Date, to: Date, timezone: string): string {
    const desde = this.time.toLocalDate(from, timezone).setLocale('es-MX');
    const hasta = this.time.toLocalDate(to, timezone).setLocale('es-MX');

    // Dentro del mismo mes no hace falta repetirlo: «del 22 al 28 de septiembre».
    const rango =
      desde.month === hasta.month
        ? `del ${desde.day} al ${hasta.toFormat("d 'de' LLLL")}`
        : `del ${desde.toFormat("d 'de' LLLL")} al ${hasta.toFormat("d 'de' LLLL")}`;

    return `¿Quién puede apoyar en el exhibidor ${rango}?`;
  }

  private plainText(question: string, options: PollOption[]): string {
    if (options.length === 0) {
      return `${question}\n\nPor ahora no hay turnos por cubrir. ¡Gracias!`;
    }
    const lineas = options.map((option) => option.text).join('\n');
    return `${question}\n\n${lineas}`;
  }
}
