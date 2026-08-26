/**
 * Mensajes salientes en su forma interna, independiente del proveedor.
 * El cliente concreto (Cloud API o stub) los traduce al formato de destino.
 */

export interface QuickReplyButton {
  /** Identificador que vuelve en el webhook cuando el usuario lo toca. */
  id: string;
  title: string;
}

export interface ListRow {
  id: string;
  title: string;
  description?: string;
}

export interface ListSection {
  title?: string;
  rows: ListRow[];
}

export interface TextMessage {
  kind: 'TEXT';
  to: string;
  body: string;
}

export interface ButtonsMessage {
  kind: 'INTERACTIVE_BUTTONS';
  to: string;
  body: string;
  header?: string;
  footer?: string;
  buttons: QuickReplyButton[];
}

export interface ListMessage {
  kind: 'INTERACTIVE_LIST';
  to: string;
  body: string;
  header?: string;
  footer?: string;
  buttonLabel: string;
  sections: ListSection[];
}

export interface TemplateMessage {
  kind: 'TEMPLATE';
  to: string;
  templateName: string;
  languageCode: string;
  /** Parámetros posicionales del cuerpo ({{1}}, {{2}}, ...). */
  bodyParams: string[];
  /** Payload que devuelve cada botón de respuesta rápida de la plantilla. */
  buttonPayloads?: string[];
}

export type OutgoingMessage = TextMessage | ButtonsMessage | ListMessage | TemplateMessage;

export interface SendResult {
  waMessageId: string;
}

/** Límites de la Cloud API. Exceder cualquiera hace que Meta rechace el mensaje. */
export const WA_LIMITS = {
  bodyLength: 1024,
  headerLength: 60,
  footerLength: 60,
  buttonTitleLength: 20,
  maxButtons: 3,
  listButtonLabelLength: 20,
  listRowTitleLength: 24,
  listRowDescriptionLength: 72,
  maxListRows: 10,
  maxListSections: 10,
} as const;
