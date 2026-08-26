import { OutgoingMessage, SendResult } from '../types/message.types';

export const WHATSAPP_CLIENT = Symbol('WHATSAPP_CLIENT');

export interface WhatsAppClient {
  send(message: OutgoingMessage): Promise<SendResult>;
  markAsRead(waMessageId: string): Promise<void>;
}

/**
 * Error de envío que distingue fallas transitorias de definitivas.
 * De esa distinción depende si el outbox reintenta o marca el mensaje como
 * fallido: reintentar un número inválido solo desperdicia cuota.
 */
export class WhatsAppSendError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
    readonly code?: number | string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'WhatsAppSendError';
  }
}
