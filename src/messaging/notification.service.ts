import { Injectable, Logger } from '@nestjs/common';
import { Participant, ParticipantStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MessageBuilder } from '../whatsapp/message-builder';
import { OutboxService } from '../whatsapp/outbox.service';
import { OutgoingMessage } from '../whatsapp/types/message.types';
import { ConversationWindowService } from './conversation-window.service';

export interface NotificationSpec {
  /** Mensaje enriquecido, válido solo dentro de la ventana de 24 horas. */
  interactive: (to: string) => OutgoingMessage;
  /** Plantilla aprobada, para cuando la ventana está cerrada. */
  template?: { name: string; params: string[]; buttonPayloads?: string[] };
  dedupeKey?: string;
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly window: ConversationWindowService,
  ) {}

  /**
   * Envía a una persona eligiendo el canal correcto.
   *
   * Dentro de la ventana de 24 horas se manda el mensaje interactivo: es gratis
   * y permite botones ricos. Fuera de ella hace falta una plantilla aprobada; si
   * la notificación no tiene plantilla definida, se omite en vez de encolar algo
   * que Meta rechazaría.
   */
  async send(
    participantId: string,
    spec: NotificationSpec,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const participant = await this.prisma.participant.findUnique({ where: { id: participantId } });
    if (!participant) return false;
    if (participant.status !== ParticipantStatus.ACTIVE) return false;

    return this.sendToParticipant(participant, spec, tx);
  }

  async sendToParticipant(
    participant: Participant,
    spec: NotificationSpec,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const open = await this.window.isOpen(participant.id);

    if (open) {
      await this.outbox.enqueue(
        spec.interactive(participant.phoneE164),
        { participantId: participant.id, dedupeKey: spec.dedupeKey },
        tx,
      );
      return true;
    }

    if (!spec.template) {
      this.logger.warn(
        `Se omitió un aviso a ${participant.fullName}: la ventana de 24 h está cerrada y ` +
          'la notificación no tiene plantilla asociada',
      );
      return false;
    }

    await this.outbox.enqueue(
      MessageBuilder.template({
        to: participant.phoneE164,
        templateName: spec.template.name,
        bodyParams: spec.template.params,
        buttonPayloads: spec.template.buttonPayloads,
      }),
      { participantId: participant.id, dedupeKey: spec.dedupeKey },
      tx,
    );
    return true;
  }

  /** Envía a varias personas resolviendo la ventana de todas de una vez. */
  async sendMany(
    participants: Participant[],
    build: (participant: Participant) => NotificationSpec,
  ): Promise<number> {
    if (participants.length === 0) return 0;

    const openIds = await this.window.openFor(participants.map((item) => item.id));
    let sent = 0;

    for (const participant of participants) {
      const spec = build(participant);
      const open = openIds.has(participant.id);

      if (open) {
        await this.outbox.enqueue(spec.interactive(participant.phoneE164), {
          participantId: participant.id,
          dedupeKey: spec.dedupeKey,
        });
        sent += 1;
        continue;
      }

      if (!spec.template) continue;

      await this.outbox.enqueue(
        MessageBuilder.template({
          to: participant.phoneE164,
          templateName: spec.template.name,
          bodyParams: spec.template.params,
          buttonPayloads: spec.template.buttonPayloads,
        }),
        { participantId: participant.id, dedupeKey: spec.dedupeKey },
      );
      sent += 1;
    }

    return sent;
  }

  /** Destinatarios de una difusión de vacante. */
  async broadcastAudience(locationId: string, excludeIds: string[]): Promise<Participant[]> {
    return this.prisma.participant.findMany({
      where: {
        status: ParticipantStatus.ACTIVE,
        coverageAlerts: true,
        optInAt: { not: null },
        id: { notIn: excludeIds },
        memberships: { some: { locationId, active: true } },
      },
    });
  }
}
