import { Logger } from '@nestjs/common';
import {
  ButtonsMessage,
  ListMessage,
  ListSection,
  QuickReplyButton,
  TemplateMessage,
  TextMessage,
  WA_LIMITS,
} from './types/message.types';

const logger = new Logger('MessageBuilder');

/**
 * Construye los mensajes salientes respetando los límites de la Cloud API.
 * Truncar aquí es preferible a que Meta rechace el envío: un título recortado
 * sigue siendo útil, un mensaje no entregado deja un turno sin cubrir.
 */
export class MessageBuilder {
  static text(to: string, body: string): TextMessage {
    return { kind: 'TEXT', to, body: truncate(body, WA_LIMITS.bodyLength, 'cuerpo') };
  }

  static buttons(params: {
    to: string;
    body: string;
    buttons: QuickReplyButton[];
    header?: string;
    footer?: string;
  }): ButtonsMessage {
    if (params.buttons.length === 0) {
      throw new Error('Un mensaje con botones necesita al menos uno');
    }
    if (params.buttons.length > WA_LIMITS.maxButtons) {
      throw new Error(
        `WhatsApp admite máximo ${WA_LIMITS.maxButtons} botones; se recibieron ${params.buttons.length}. Usa una lista.`,
      );
    }
    return {
      kind: 'INTERACTIVE_BUTTONS',
      to: params.to,
      body: truncate(params.body, WA_LIMITS.bodyLength, 'cuerpo'),
      header: params.header
        ? truncate(params.header, WA_LIMITS.headerLength, 'encabezado')
        : undefined,
      footer: params.footer ? truncate(params.footer, WA_LIMITS.footerLength, 'pie') : undefined,
      buttons: params.buttons.map((button) => ({
        id: button.id,
        title: truncate(button.title, WA_LIMITS.buttonTitleLength, 'botón'),
      })),
    };
  }

  static list(params: {
    to: string;
    body: string;
    buttonLabel: string;
    sections: ListSection[];
    header?: string;
    footer?: string;
  }): ListMessage {
    const totalRows = params.sections.reduce((sum, section) => sum + section.rows.length, 0);
    if (totalRows === 0) {
      throw new Error('Una lista necesita al menos una fila');
    }
    if (totalRows > WA_LIMITS.maxListRows) {
      throw new Error(
        `WhatsApp admite máximo ${WA_LIMITS.maxListRows} filas por lista; se recibieron ${totalRows}. Pagina el contenido.`,
      );
    }
    return {
      kind: 'INTERACTIVE_LIST',
      to: params.to,
      body: truncate(params.body, WA_LIMITS.bodyLength, 'cuerpo'),
      header: params.header
        ? truncate(params.header, WA_LIMITS.headerLength, 'encabezado')
        : undefined,
      footer: params.footer ? truncate(params.footer, WA_LIMITS.footerLength, 'pie') : undefined,
      buttonLabel: truncate(params.buttonLabel, WA_LIMITS.listButtonLabelLength, 'botón de lista'),
      sections: params.sections.slice(0, WA_LIMITS.maxListSections).map((section) => ({
        title: section.title,
        rows: section.rows.map((row) => ({
          id: row.id,
          title: truncate(row.title, WA_LIMITS.listRowTitleLength, 'fila'),
          description: row.description
            ? truncate(row.description, WA_LIMITS.listRowDescriptionLength, 'descripción')
            : undefined,
        })),
      })),
    };
  }

  static template(params: {
    to: string;
    templateName: string;
    bodyParams: string[];
    buttonPayloads?: string[];
    languageCode?: string;
  }): TemplateMessage {
    return {
      kind: 'TEMPLATE',
      to: params.to,
      templateName: params.templateName,
      languageCode: params.languageCode ?? 'es_MX',
      bodyParams: params.bodyParams,
      buttonPayloads: params.buttonPayloads,
    };
  }
}

function truncate(value: string, max: number, what: string): string {
  if (value.length <= max) return value;
  logger.warn(`Se truncó el ${what} de ${value.length} a ${max} caracteres`);
  return `${value.slice(0, max - 1)}…`;
}
