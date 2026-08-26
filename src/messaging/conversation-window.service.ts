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
    const last = await this.prisma.inboundMessage.findFirst({
      where: { participantId },
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
    const recent = await this.prisma.inboundMessage.findMany({
      where: { participantId: { in: participantIds }, receivedAt: { gte: threshold } },
      select: { participantId: true },
      distinct: ['participantId'],
    });

    return new Set(
      recent.map((item) => item.participantId).filter((id): id is string => id !== null),
    );
  }
}
