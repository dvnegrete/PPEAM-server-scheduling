import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OutboxStatus, Prisma } from '@prisma/client';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { WHATSAPP_CLIENT, WhatsAppClient, WhatsAppSendError } from './clients/whatsapp-client.interface';
import { OutgoingMessage } from './types/message.types';

const BATCH_SIZE = 20;
const MAX_ATTEMPTS = 5;
/** Un mensaje atorado en SENDING más de este tiempo se considera huérfano. */
const STUCK_AFTER_MINUTES = 5;

/**
 * Drena el outbox. Usa `FOR UPDATE SKIP LOCKED` para que varias instancias del
 * servicio puedan correr en paralelo sin enviar dos veces el mismo mensaje, sin
 * necesidad de una cola externa: la propia base de datos es la cola.
 */
@Injectable()
export class OutboxWorker {
  private readonly logger = new Logger(OutboxWorker.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    @Inject(WHATSAPP_CLIENT) private readonly client: WhatsAppClient,
  ) {}

  @Cron(CronExpression.EVERY_5_SECONDS, { name: 'outbox-drain' })
  async drain(): Promise<void> {
    if (this.config.isTest) return;
    // Evita solapamiento si un lote tarda más que el intervalo del cron.
    if (this.running) return;
    this.running = true;
    try {
      await this.processBatch();
    } catch (error) {
      this.logger.error(`Fallo al drenar el outbox: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }

  /** Procesa un lote. Público para poder invocarlo desde pruebas y comandos. */
  async processBatch(): Promise<number> {
    const claimed = await this.claimBatch();
    if (claimed.length === 0) return 0;

    let delivered = 0;
    for (const id of claimed) {
      if (await this.deliver(id)) delivered += 1;
    }
    return delivered;
  }

  /**
   * Toma un lote y lo marca SENDING en una transacción corta. El SKIP LOCKED
   * hace que dos workers concurrentes se repartan filas distintas.
   */
  private async claimBatch(): Promise<string[]> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM outbox_messages
        WHERE status = 'PENDING' AND next_attempt_at <= NOW()
        ORDER BY created_at
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      `);
      const ids = rows.map((row) => row.id);
      if (ids.length > 0) {
        await tx.outboxMessage.updateMany({
          where: { id: { in: ids } },
          data: { status: OutboxStatus.SENDING },
        });
      }
      return ids;
    });
  }

  private async deliver(id: string): Promise<boolean> {
    const record = await this.prisma.outboxMessage.findUnique({ where: { id } });
    if (!record) return false;

    try {
      const result = await this.client.send(record.payload as unknown as OutgoingMessage);
      await this.prisma.outboxMessage.update({
        where: { id },
        data: {
          status: OutboxStatus.SENT,
          sentAt: new Date(),
          waMessageId: result.waMessageId,
          attempts: { increment: 1 },
          error: null,
        },
      });
      return true;
    } catch (error) {
      await this.handleFailure(id, record.attempts + 1, error);
      return false;
    }
  }

  private async handleFailure(id: string, attempts: number, error: unknown): Promise<void> {
    const permanent = error instanceof WhatsAppSendError && error.permanent;
    const exhausted = attempts >= MAX_ATTEMPTS;
    const message = error instanceof Error ? error.message : String(error);

    if (permanent || exhausted) {
      this.logger.error(
        `Mensaje ${id} descartado tras ${attempts} intento(s)${permanent ? ' (error definitivo)' : ''}: ${message}`,
      );
      await this.prisma.outboxMessage.update({
        where: { id },
        data: { status: OutboxStatus.FAILED, attempts, error: message },
      });
      return;
    }

    const delaySeconds = Math.min(30 * 2 ** (attempts - 1), 1800);
    this.logger.warn(
      `Mensaje ${id} falló (intento ${attempts}), reintento en ${delaySeconds}s: ${message}`,
    );
    await this.prisma.outboxMessage.update({
      where: { id },
      data: {
        status: OutboxStatus.PENDING,
        attempts,
        error: message,
        nextAttemptAt: new Date(Date.now() + delaySeconds * 1000),
      },
    });
  }

  /**
   * Devuelve a la cola los mensajes que quedaron en SENDING porque el proceso
   * murió a media entrega. Sin esto, un reinicio dejaría avisos sin enviar.
   */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'outbox-unstick' })
  async requeueStuck(): Promise<void> {
    if (this.config.isTest) return;
    const threshold = new Date(Date.now() - STUCK_AFTER_MINUTES * 60_000);
    const { count } = await this.prisma.outboxMessage.updateMany({
      where: { status: OutboxStatus.SENDING, updatedAt: { lt: threshold } },
      data: { status: OutboxStatus.PENDING },
    });
    if (count > 0) {
      this.logger.warn(`Se devolvieron a la cola ${count} mensaje(s) atorados en envío`);
    }
  }
}
