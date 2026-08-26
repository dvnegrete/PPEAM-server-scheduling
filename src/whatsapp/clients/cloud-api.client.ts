import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance, isAxiosError } from 'axios';
import { AppConfigService } from '../../config/app-config.service';
import { OutgoingMessage, SendResult } from '../types/message.types';
import { WhatsAppClient, WhatsAppSendError } from './whatsapp-client.interface';

/** Códigos de Meta que sí vale la pena reintentar. */
const TRANSIENT_META_CODES = new Set([130429, 131056, 133016, 368, 500, 1, 2, 4]);

interface MetaSendResponse {
  messages?: Array<{ id: string }>;
}

interface MetaErrorBody {
  error?: { message?: string; code?: number; error_subcode?: number; type?: string };
}

@Injectable()
export class CloudApiClient implements WhatsAppClient {
  private readonly logger = new Logger(CloudApiClient.name);
  private readonly http: AxiosInstance;

  constructor(private readonly config: AppConfigService) {
    const { apiVersion, phoneNumberId, accessToken } = this.config.whatsapp;
    this.http = axios.create({
      baseURL: `https://graph.facebook.com/${apiVersion}/${phoneNumberId}`,
      timeout: 15_000,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    const payload = this.toMetaPayload(message);
    try {
      const { data } = await this.http.post<MetaSendResponse>('/messages', payload);
      const waMessageId = data.messages?.[0]?.id;
      if (!waMessageId) {
        throw new WhatsAppSendError('Meta respondió sin identificador de mensaje', false);
      }
      return { waMessageId };
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  async markAsRead(waMessageId: string): Promise<void> {
    try {
      await this.http.post('/messages', {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: waMessageId,
      });
    } catch (error) {
      // Marcar como leído es cosmético: nunca debe interrumpir el procesamiento.
      this.logger.debug(`No se pudo marcar como leído ${waMessageId}: ${String(error)}`);
    }
  }

  /** Traduce el mensaje interno al cuerpo que espera la Cloud API. */
  private toMetaPayload(message: OutgoingMessage): Record<string, unknown> {
    const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: message.to };

    switch (message.kind) {
      case 'TEXT':
        return { ...base, type: 'text', text: { preview_url: false, body: message.body } };

      case 'INTERACTIVE_BUTTONS':
        return {
          ...base,
          type: 'interactive',
          interactive: {
            type: 'button',
            ...(message.header ? { header: { type: 'text', text: message.header } } : {}),
            body: { text: message.body },
            ...(message.footer ? { footer: { text: message.footer } } : {}),
            action: {
              buttons: message.buttons.map((button) => ({
                type: 'reply',
                reply: { id: button.id, title: button.title },
              })),
            },
          },
        };

      case 'INTERACTIVE_LIST':
        return {
          ...base,
          type: 'interactive',
          interactive: {
            type: 'list',
            ...(message.header ? { header: { type: 'text', text: message.header } } : {}),
            body: { text: message.body },
            ...(message.footer ? { footer: { text: message.footer } } : {}),
            action: {
              button: message.buttonLabel,
              sections: message.sections.map((section) => ({
                ...(section.title ? { title: section.title } : {}),
                rows: section.rows.map((row) => ({
                  id: row.id,
                  title: row.title,
                  ...(row.description ? { description: row.description } : {}),
                })),
              })),
            },
          },
        };

      case 'TEMPLATE': {
        const components: Array<Record<string, unknown>> = [];
        if (message.bodyParams.length > 0) {
          components.push({
            type: 'body',
            parameters: message.bodyParams.map((text) => ({ type: 'text', text })),
          });
        }
        message.buttonPayloads?.forEach((payload, index) => {
          components.push({
            type: 'button',
            sub_type: 'quick_reply',
            index: String(index),
            parameters: [{ type: 'payload', payload }],
          });
        });
        return {
          ...base,
          type: 'template',
          template: {
            name: message.templateName,
            language: { code: message.languageCode },
            ...(components.length > 0 ? { components } : {}),
          },
        };
      }
    }
  }

  private normalizeError(error: unknown): WhatsAppSendError {
    if (error instanceof WhatsAppSendError) return error;

    if (isAxiosError(error)) {
      const status = error.response?.status;
      const body = error.response?.data as MetaErrorBody | undefined;
      const code = body?.error?.code;
      const detail = body?.error?.message ?? error.message;

      // Sin respuesta (timeout, DNS, corte de red) siempre es transitorio.
      if (status === undefined) {
        return new WhatsAppSendError(`Fallo de red al enviar: ${detail}`, false, code);
      }

      const transient =
        status >= 500 || status === 429 || (code !== undefined && TRANSIENT_META_CODES.has(code));

      return new WhatsAppSendError(
        `Meta rechazó el envío (HTTP ${status}, código ${code ?? 'n/d'}): ${detail}`,
        !transient,
        code,
        status,
      );
    }

    return new WhatsAppSendError(`Error inesperado al enviar: ${String(error)}`, false);
  }
}
