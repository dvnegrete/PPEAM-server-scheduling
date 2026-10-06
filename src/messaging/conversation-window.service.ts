import { Injectable } from '@nestjs/common';
import { TimeService } from '../common/time/time.service';
import { PrismaService } from '../prisma/prisma.service';

/** Duración de la ventana de servicio de WhatsApp. */
const WINDOW_HOURS = 24;
/** Margen de seguridad para no enviar justo en el límite y que Meta lo rechace. */
const SAFETY_MINUTES = 5;

/**
 * Determina si se le puede escribir libremente a alguien.
 *
 * WhatsApp solo permite mensajes libres dentro de las 24 horas siguientes al
 * último mensaje de la persona. Fuera de esa ventana hay que usar una plantilla
 * aprobada, que además se cobra. Preguntar antes de enviar evita mensajes
 * rechazados y gasto innecesario.
 */
@Injectable()
export class ConversationWindowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly time: TimeService,
  ) {}

  async isOpen(participantId: string): Promise<boolean> {
    const persona = await this.prisma.participant.findUnique({
      where: { id: participantId },
      select: { phoneChangedAt: true },
    });

    const last = await this.prisma.inboundMessage.findFirst({
      where: {
        participantId,
        // Solo cuentan los mensajes que llegaron al número vigente. La ventana
        // es del número, no de la persona: tras un cambio, el número nuevo nace
        // sin historial aunque la persona lleve años escribiendo.
        ...(persona?.phoneChangedAt ? { receivedAt: { gte: persona.phoneChangedAt } } : {}),
      },
      orderBy: { receivedAt: 'desc' },
      select: { receivedAt: true },
    });
    if (!last) return false;

    const limit = new Date(
      last.receivedAt.getTime() + WINDOW_HOURS * 3_600_000 - SAFETY_MINUTES * 60_000,
    );
    return this.time.now() < limit;
  }

  /** Consulta en bloque, para difusiones a todo el padrón. */
  async openFor(participantIds: string[]): Promise<Set<string>> {
    if (participantIds.length === 0) return new Set();

    const threshold = new Date(
      this.time.now().getTime() - WINDOW_HOURS * 3_600_000 + SAFETY_MINUTES * 60_000,
    );
    // El filtro por número vigente no se puede expresar en la consulta: compara
    // dos columnas de tablas distintas. Se traen las marcas de cambio aparte y
    // se descartan en memoria los mensajes anteriores al número actual.
    const [personas, recent] = await Promise.all([
      this.prisma.participant.findMany({
        where: { id: { in: participantIds }, phoneChangedAt: { not: null } },
        select: { id: true, phoneChangedAt: true },
      }),
      this.prisma.inboundMessage.findMany({
        where: { participantId: { in: participantIds }, receivedAt: { gte: threshold } },
        select: { participantId: true, receivedAt: true },
        orderBy: { receivedAt: 'desc' },
        distinct: ['participantId'],
      }),
    ]);

    const cambioDeNumero = new Map(personas.map((persona) => [persona.id, persona.phoneChangedAt]));

    const abiertos = recent
      .filter((item): item is { participantId: string; receivedAt: Date } =>
        Boolean(item.participantId),
      )
      .filter((item) => {
        const cambio = cambioDeNumero.get(item.participantId);
        return !cambio || item.receivedAt >= cambio;
      })
      .map((item) => item.participantId);

    return new Set(abiertos);
  }
}
