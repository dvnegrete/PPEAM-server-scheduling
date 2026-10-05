import { Injectable, Logger } from '@nestjs/common';
import { Participant, ParticipantStatus, Prisma } from '@prisma/client';
import { PhoneService } from '../common/phone/phone.service';
import { SettingsService } from '../common/settings/settings.service';
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
    private readonly settings: SettingsService,
    private readonly phone: PhoneService,
  ) {}

  /**
   * Filtra a quiénes se les puede entregar según el modo de mensajería del punto.
   *
   * Con una cuenta de prueba de Meta solo se puede escribir a los números dados de
   * alta; enviar a cualquier otro se rechaza y ensucia el outbox con fallos que no
   * dicen nada nuevo. Es preferible no encolarlos y dejar constancia en el log.
   */
  private async deliverableIds(participants: Participant[]): Promise<Set<string>> {
    if (participants.length === 0) return new Set();

    const memberships = await this.prisma.locationMembership.findMany({
      where: { participantId: { in: participants.map((item) => item.id) }, active: true },
      select: { participantId: true, locationId: true },
      orderBy: { createdAt: 'asc' },
    });

    const locationOf = new Map<string, string>();
    for (const membership of memberships) {
      if (!locationOf.has(membership.participantId)) {
        locationOf.set(membership.participantId, membership.locationId);
      }
    }

    // Los ajustes se resuelven una vez por punto, no una vez por destinatario.
    const settingsOf = new Map<string, Awaited<ReturnType<SettingsService['forLocation']>>>();
    for (const locationId of new Set(locationOf.values())) {
      settingsOf.set(locationId, await this.settings.forLocation(locationId));
    }

    const allowed = new Set<string>();
    for (const participant of participants) {
      const locationId = locationOf.get(participant.id);
      const settings = locationId ? settingsOf.get(locationId) : undefined;

      // Sin punto asociado no hay política que aplicar: se deja pasar y que el
      // outbox reporte el resultado real.
      if (!settings || settings.messagingMode === 'live') {
        allowed.add(participant.id);
        continue;
      }

      const variantes = this.phone.lookupVariants(participant.phoneE164);
      const permitido = settings.allowedRecipients.some((raw) => {
        const normalizado = this.phone.tryNormalize(raw);
        return normalizado ? variantes.includes(normalizado) : variantes.includes(raw);
      });

      if (permitido) {
        allowed.add(participant.id);
      } else {
        this.logger.debug(
          `Modo de prueba: se omite el aviso a ${participant.fullName} ` +
            `(${participant.phoneE164} no está en la lista de números autorizados)`,
        );
      }
    }

    return allowed;
  }

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
    const deliverable = await this.deliverableIds([participant]);
    if (!deliverable.has(participant.id)) return false;

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

    const deliverable = await this.deliverableIds(participants);
    const destinatarios = participants.filter((item) => deliverable.has(item.id));
    if (destinatarios.length === 0) return 0;

    const openIds = await this.window.openFor(destinatarios.map((item) => item.id));
    let sent = 0;

    for (const participant of destinatarios) {
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
