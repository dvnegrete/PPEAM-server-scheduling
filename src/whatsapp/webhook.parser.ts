import { Injectable, Logger } from '@nestjs/common';
import { PhoneService } from '../common/phone/phone.service';
import {
  InboundEvent,
  InboundStatusEvent,
  MetaMessage,
  MetaWebhookBody,
} from './types/webhook.types';

/**
 * Traduce el payload de Meta a eventos internos. Es deliberadamente tolerante:
 * un mensaje que no se entiende se marca como `unsupported` en vez de tumbar el
 * webhook, porque Meta reintentaría el lote completo y bloquearía los mensajes
 * que sí eran válidos.
 */
@Injectable()
export class WebhookParser {
  private readonly logger = new Logger(WebhookParser.name);

  constructor(private readonly phone: PhoneService) {}

  parse(body: MetaWebhookBody): { events: InboundEvent[]; statuses: InboundStatusEvent[] } {
    const events: InboundEvent[] = [];
    const statuses: InboundStatusEvent[] = [];

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value) continue;

        const profileNames = new Map<string, string>();
        for (const contact of value.contacts ?? []) {
          if (contact.wa_id && contact.profile?.name) {
            profileNames.set(contact.wa_id, contact.profile.name);
          }
        }

        for (const message of value.messages ?? []) {
          const event = this.toEvent(message, profileNames);
          if (event) events.push(event);
        }

        for (const status of value.statuses ?? []) {
          if (!status.id || !status.status) continue;
          statuses.push({
            waMessageId: status.id,
            status: status.status,
            at: toDate(status.timestamp),
            errorMessage: status.errors?.[0]?.message ?? status.errors?.[0]?.title,
          });
        }
      }
    }

    return { events, statuses };
  }

  private toEvent(message: MetaMessage, profileNames: Map<string, string>): InboundEvent | null {
    if (!message.id || !message.from) {
      this.logger.warn('Mensaje entrante sin id o remitente; se descarta');
      return null;
    }

    const normalized = this.phone.tryNormalize(message.from);
    if (!normalized) {
      this.logger.warn(`No se pudo normalizar el remitente ${message.from}`);
      return null;
    }

    const base = {
      waMessageId: message.id,
      from: normalized,
      rawFrom: message.from,
      profileName: profileNames.get(message.from),
      receivedAt: toDate(message.timestamp),
    };

    if (message.type === 'text' && message.text?.body) {
      return { ...base, type: 'text', text: message.text.body.trim() };
    }

    if (message.type === 'interactive') {
      const buttonReply = message.interactive?.button_reply;
      if (buttonReply?.id) {
        return {
          ...base,
          type: 'reply',
          replyId: buttonReply.id,
          title: buttonReply.title,
          source: 'button',
        };
      }
      const listReply = message.interactive?.list_reply;
      if (listReply?.id) {
        return {
          ...base,
          type: 'reply',
          replyId: listReply.id,
          title: listReply.title,
          source: 'list',
        };
      }
    }

    // Botón de respuesta rápida de una plantilla.
    if (message.type === 'button' && message.button?.payload) {
      return {
        ...base,
        type: 'reply',
        replyId: message.button.payload,
        title: message.button.text,
        source: 'template',
      };
    }

    return { ...base, type: 'unsupported', originalType: message.type ?? 'desconocido' };
  }
}

function toDate(timestamp?: string): Date {
  const seconds = Number(timestamp);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date();
}
