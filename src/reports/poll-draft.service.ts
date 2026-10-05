import { Injectable } from '@nestjs/common';
import { ShiftStatus } from '@prisma/client';
import { TimeService } from '../common/time/time.service';
import { PrismaService } from '../prisma/prisma.service';
import { OCCUPYING_STATUSES } from '../scheduling/shifts.service';

/** Límite de opciones de una encuesta de WhatsApp. */
export const WHATSAPP_POLL_MAX_OPTIONS = 12;

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

  /** «jueves 24 · 7:00 a 9:00 (faltan 2)» */
  private optionText(
    shift: { date: Date; startMinute: number; endMinute: number },
    faltan: number,
    timezone: string,
  ): string {
    const dia = this.time.toLocalDate(shift.date, timezone).setLocale('es-MX').toFormat('cccc d');
    const horario = this.time.formatRange(shift.startMinute, shift.endMinute);
    const cuantos = faltan === 1 ? 'falta 1' : `faltan ${faltan}`;
    return `${dia} · ${horario} (${cuantos})`;
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
    const lineas = options.map((option) => `• ${option.text}`).join('\n');
    return `${question}\n\n${lineas}`;
  }
}
