/** Estructura del webhook de la Cloud API (solo los campos que se usan). */
export interface MetaWebhookBody {
  object?: string;
  entry?: MetaEntry[];
}

export interface MetaEntry {
  id?: string;
  changes?: MetaChange[];
}

export interface MetaChange {
  field?: string;
  value?: MetaChangeValue;
}

export interface MetaChangeValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
  messages?: MetaMessage[];
  statuses?: MetaStatus[];
}

export interface MetaMessage {
  id?: string;
  from?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  /** Botón de una plantilla: devuelve el payload configurado al crearla. */
  button?: { payload?: string; text?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
  };
  context?: { id?: string; from?: string };
}

export interface MetaStatus {
  id?: string;
  status?: string;
  timestamp?: string;
  recipient_id?: string;
  errors?: Array<{ code?: number; title?: string; message?: string }>;
}

// ---------------------------------------------------------------------------
// Evento normalizado que consume el resto del sistema
// ---------------------------------------------------------------------------

interface InboundBase {
  waMessageId: string;
  /** Teléfono ya normalizado a E.164 canónico. */
  from: string;
  /** Teléfono tal como lo mandó Meta, por si hace falta responder igual. */
  rawFrom: string;
  profileName?: string;
  receivedAt: Date;
}

export interface InboundTextEvent extends InboundBase {
  type: 'text';
  text: string;
}

/**
 * Toda respuesta a un control interactivo se unifica aquí: botón de mensaje,
 * fila de lista y botón de plantilla. El router de conversación solo necesita
 * `replyId`, sin importar de qué control vino.
 */
export interface InboundReplyEvent extends InboundBase {
  type: 'reply';
  replyId: string;
  title?: string;
  source: 'button' | 'list' | 'template';
}

export interface InboundUnsupportedEvent extends InboundBase {
  type: 'unsupported';
  originalType: string;
}

export type InboundEvent = InboundTextEvent | InboundReplyEvent | InboundUnsupportedEvent;

export interface InboundStatusEvent {
  waMessageId: string;
  status: string;
  at: Date;
  errorMessage?: string;
}

export const WHATSAPP_INBOUND_EVENT = 'whatsapp.inbound';
