import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OutboxStatus, Prisma } from '@prisma/client';
import { PhoneService } from '../common/phone/phone.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  InboundEvent,
  InboundStatusEvent,
  WHATSAPP_INBOUND_EVENT,
} from './types/webhook.types';

/**
 * Registra lo que llega de WhatsApp y lo publica para que lo atienda la capa de
 * conversación.
 *
 * El registro es lo primero que ocurre y es idempotente por `waMessageId`: Meta
 * reintenta los webhooks que no responden 200 a tiempo, y sin esta guarda una
 * sola cancelación podría procesarse dos veces.
 */
@Injectable()
export class InboundService {
  private readonly logger = new Logger(InboundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly phone: PhoneService,
    private readonly events: EventEmitter2,
  ) {}

  async ingest(events: InboundEvent[], statuses: InboundStatusEvent[]): Promise<void> {
    for (const event of events) {
      await this.ingestOne(event);
    }
    for (const status of statuses) {
      await this.applyStatus(status);
    }
  }

  private async ingestOne(event: InboundEvent): Promise<void> {
    const participant = await this.findParticipant(event.from);

    try {
      await this.prisma.inboundMessage.create({
        data: {
          waMessageId: event.waMessageId,
          fromPhone: event.from,
          participantId: participant?.id ?? null,
          type: event.type,
          payload: event as unknown as Prisma.InputJsonValue,
          receivedAt: event.receivedAt,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        this.logger.debug(`Mensaje ${event.waMessageId} ya procesado; se ignora el reintento`);
        return;
      }
      throw error;
    }

    // El manejo real ocurre fuera del ciclo del webhook: Meta espera un 200 rápido.
    this.events.emit(WHATSAPP_INBOUND_EVENT, event);
  }

  /** Busca al participante tolerando las variantes del número mexicano. */
  async findParticipant(e164: string) {
    return this.prisma.participant.findFirst({
      where: { phoneE164: { in: this.phone.lookupVariants(e164) } },
    });
  }

  /** Marca como procesado; lo llama la capa de conversación al terminar. */
  async markProcessed(waMessageId: string, error?: string): Promise<void> {
    await this.prisma.inboundMessage.updateMany({
      where: { waMessageId },
      data: { processedAt: new Date(), error: error ?? null },
    });
  }

  /** Refleja los acuses de entrega de Meta en el outbox, para diagnóstico. */
  private async applyStatus(status: InboundStatusEvent): Promise<void> {
    if (status.status !== 'failed') return;
    await this.prisma.outboxMessage.updateMany({
      where: { waMessageId: status.waMessageId },
      data: { status: OutboxStatus.FAILED, error: status.errorMessage ?? 'Entrega fallida' },
    });
    this.logger.warn(
      `WhatsApp reportó entrega fallida de ${status.waMessageId}: ${status.errorMessage ?? 'sin detalle'}`,
    );
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
