import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { OutgoingMessage, SendResult } from '../types/message.types';
import { WhatsAppClient } from './whatsapp-client.interface';

export interface StubSentMessage {
  at: Date;
  message: OutgoingMessage;
  waMessageId: string;
}

/**
 * Cliente de desarrollo y pruebas: no llama a Meta, escribe el mensaje en el log
 * y lo guarda en memoria. Permite recorrer todos los flujos —incluidos los que
 * dependen de la respuesta del usuario— sin credenciales, sin costo y sin
 * esperar la aprobación de plantillas.
 */
@Injectable()
export class StubWhatsAppClient implements WhatsAppClient {
  private readonly logger = new Logger('WhatsApp(stub)');
  private readonly sent: StubSentMessage[] = [];

  send(message: OutgoingMessage): Promise<SendResult> {
    const waMessageId = `stub.${randomUUID()}`;
    this.sent.push({ at: new Date(), message, waMessageId });
    this.logger.log(`→ ${message.to}\n${describe(message)}`);
    return Promise.resolve({ waMessageId });
  }

  markAsRead(): Promise<void> {
    return Promise.resolve();
  }

  /** Mensajes enviados, opcionalmente filtrados por destinatario. */
  history(to?: string): StubSentMessage[] {
    return to ? this.sent.filter((entry) => entry.message.to === to) : [...this.sent];
  }

  clear(): void {
    this.sent.length = 0;
  }
}

function describe(message: OutgoingMessage): string {
  switch (message.kind) {
    case 'TEXT':
      return message.body;
    case 'INTERACTIVE_BUTTONS':
      return `${message.body}\n${message.buttons
        .map((button) => `  [${button.title}] (${button.id})`)
        .join('\n')}`;
    case 'INTERACTIVE_LIST':
      return `${message.body}\n  Botón: ${message.buttonLabel}\n${message.sections
        .flatMap((section) =>
          section.rows.map((row) => `  • ${row.title} (${row.id})${row.description ? ` — ${row.description}` : ''}`),
        )
        .join('\n')}`;
    case 'TEMPLATE':
      return `plantilla ${message.templateName} [${message.bodyParams.join(' | ')}]`;
  }
}
