import { PhoneService } from '../common/phone/phone.service';
import { MetaWebhookBody } from './types/webhook.types';
import { WebhookParser } from './webhook.parser';

function envelope(value: Record<string, unknown>): MetaWebhookBody {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA', changes: [{ field: 'messages', value }] }],
  };
}

describe('WebhookParser', () => {
  const parser = new WebhookParser(new PhoneService());

  it('normaliza el remitente mexicano que manda WhatsApp', () => {
    const { events } = parser.parse(
      envelope({
        contacts: [{ profile: { name: 'Ana' }, wa_id: '5215512345678' }],
        messages: [
          {
            id: 'wamid.1',
            from: '5215512345678',
            timestamp: '1787000000',
            type: 'text',
            text: { body: '  no puedo el jueves  ' },
          },
        ],
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'text',
      from: '+525512345678',
      rawFrom: '5215512345678',
      profileName: 'Ana',
      text: 'no puedo el jueves',
    });
  });

  it('unifica botón, fila de lista y botón de plantilla en un mismo evento', () => {
    const { events } = parser.parse(
      envelope({
        messages: [
          {
            id: 'wamid.boton',
            from: '5215512345678',
            type: 'interactive',
            interactive: { type: 'button_reply', button_reply: { id: 'CANCELAR', title: 'Cancelar' } },
          },
          {
            id: 'wamid.lista',
            from: '5215512345678',
            type: 'interactive',
            interactive: { type: 'list_reply', list_reply: { id: 'TURNO:abc', title: 'jueves 7:00' } },
          },
          {
            id: 'wamid.plantilla',
            from: '5215512345678',
            type: 'button',
            button: { payload: 'CONFIRMO:xyz', text: 'Confirmo' },
          },
        ],
      }),
    );

    expect(events.map((event) => event.type)).toEqual(['reply', 'reply', 'reply']);
    expect(events.map((event) => (event as { replyId: string }).replyId)).toEqual([
      'CANCELAR',
      'TURNO:abc',
      'CONFIRMO:xyz',
    ]);
    expect(events.map((event) => (event as { source: string }).source)).toEqual([
      'button',
      'list',
      'template',
    ]);
  });

  it('marca como no soportado lo que no sabe manejar, sin descartar el lote', () => {
    const { events } = parser.parse(
      envelope({
        messages: [
          { id: 'wamid.audio', from: '5215512345678', type: 'audio' },
          { id: 'wamid.texto', from: '5215512345678', type: 'text', text: { body: 'hola' } },
        ],
      }),
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'unsupported', originalType: 'audio' });
    expect(events[1]).toMatchObject({ type: 'text' });
  });

  it('descarta mensajes sin identificador o con remitente ilegible', () => {
    const { events } = parser.parse(
      envelope({
        messages: [
          { from: '5215512345678', type: 'text', text: { body: 'sin id' } },
          { id: 'wamid.x', from: 'no-es-telefono', type: 'text', text: { body: 'raro' } },
        ],
      }),
    );
    expect(events).toHaveLength(0);
  });

  it('extrae los acuses de entrega', () => {
    const { statuses } = parser.parse(
      envelope({
        statuses: [
          { id: 'wamid.1', status: 'delivered', timestamp: '1787000000' },
          {
            id: 'wamid.2',
            status: 'failed',
            timestamp: '1787000001',
            errors: [{ code: 131047, message: 'Ventana de 24 horas cerrada' }],
          },
        ],
      }),
    );

    expect(statuses).toHaveLength(2);
    expect(statuses[1]).toMatchObject({
      waMessageId: 'wamid.2',
      status: 'failed',
      errorMessage: 'Ventana de 24 horas cerrada',
    });
  });

  it('tolera un cuerpo vacío o desconocido', () => {
    expect(parser.parse({})).toEqual({ events: [], statuses: [] });
    expect(parser.parse({ entry: [{ changes: [{}] }] })).toEqual({ events: [], statuses: [] });
  });
});
