import { Injectable, Logger } from '@nestjs/common';
import { OutboxKind, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OutgoingMessage } from './types/message.types';

export interface EnqueueOptions {
  participantId?: string | null;
  /**
   * Llave de idempotencia (p. ej. `reminder:<assignmentId>`). Si ya existe un
   * mensaje con esta llave, no se encola otro. Es lo que evita que un reintento
   * del cron mande dos veces el mismo recordatorio.
   */
  dedupeKey?: string;
  /** Retrasa el primer intento de envío. */
  notBefore?: Date;
}

/**
 * Punto único de salida hacia WhatsApp.
 *
 * Nunca se llama al cliente de Meta desde un caso de uso: se escribe aquí, en la
 * misma transacción que el cambio de estado. Así es imposible que un turno quede
 * cancelado sin que nadie se entere porque la API de Meta estaba caída.
 */
@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(private readonly prisma: PrismaService) {}

  async enqueue(
    message: OutgoingMessage,
    options: EnqueueOptions = {},
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = tx ?? this.prisma;
    const data = {
      toPhone: message.to,
      participantId: options.participantId ?? null,
      kind: toOutboxKind(message),
      templateName: message.kind === 'TEMPLATE' ? message.templateName : null,
      payload: message as unknown as Prisma.InputJsonValue,
      nextAttemptAt: options.notBefore ?? new Date(),
      dedupeKey: options.dedupeKey ?? null,
    };

    if (options.dedupeKey) {
      // upsert deja la fila existente intacta: si ya se envió, no se reenvía.
      await client.outboxMessage.upsert({
        where: { dedupeKey: options.dedupeKey },
        create: data,
        update: {},
      });
      return;
    }

    await client.outboxMessage.create({ data });
  }

  /** Encola el mismo contenido para varios destinatarios (difusión de vacantes). */
  async enqueueMany(
    messages: Array<{ message: OutgoingMessage; options?: EnqueueOptions }>,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    let count = 0;
    for (const item of messages) {
      await this.enqueue(item.message, item.options ?? {}, tx);
      count += 1;
    }
    this.logger.debug(`Encolados ${count} mensajes`);
    return count;
  }
}

function toOutboxKind(message: OutgoingMessage): OutboxKind {
  switch (message.kind) {
    case 'TEXT':
      return OutboxKind.TEXT;
    case 'TEMPLATE':
      return OutboxKind.TEMPLATE;
    default:
      return OutboxKind.INTERACTIVE;
  }
}
