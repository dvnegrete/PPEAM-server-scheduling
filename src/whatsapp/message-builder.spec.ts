import { MessageBuilder } from './message-builder';
import { WA_LIMITS } from './types/message.types';

describe('MessageBuilder', () => {
  it('trunca el cuerpo al límite de WhatsApp en vez de dejar que Meta lo rechace', () => {
    const message = MessageBuilder.text('+525512345678', 'a'.repeat(2000));
    expect(message.body).toHaveLength(WA_LIMITS.bodyLength);
    expect(message.body.endsWith('…')).toBe(true);
  });

  it('trunca títulos de botón largos', () => {
    const message = MessageBuilder.buttons({
      to: '+525512345678',
      body: 'Confirma tu turno',
      buttons: [{ id: 'OK', title: 'Sí, confirmo mi asistencia al turno' }],
    });
    expect(message.buttons[0].title).toHaveLength(WA_LIMITS.buttonTitleLength);
  });

  it('rechaza más de tres botones para que se use una lista', () => {
    expect(() =>
      MessageBuilder.buttons({
        to: '+525512345678',
        body: 'Elige',
        buttons: [1, 2, 3, 4].map((n) => ({ id: `B${n}`, title: `Opción ${n}` })),
      }),
    ).toThrow(/máximo 3 botones/);
  });

  it('rechaza listas con más de diez filas', () => {
    expect(() =>
      MessageBuilder.list({
        to: '+525512345678',
        body: 'Tus turnos',
        buttonLabel: 'Ver',
        sections: [
          {
            rows: Array.from({ length: 11 }, (_, i) => ({ id: `T${i}`, title: `Turno ${i}` })),
          },
        ],
      }),
    ).toThrow(/máximo 10 filas/);
  });

  it('exige contenido en los mensajes interactivos', () => {
    expect(() =>
      MessageBuilder.buttons({ to: '+52', body: 'x', buttons: [] }),
    ).toThrow(/al menos uno/);
    expect(() =>
      MessageBuilder.list({ to: '+52', body: 'x', buttonLabel: 'Ver', sections: [] }),
    ).toThrow(/al menos una fila/);
  });

  it('usa español de México como idioma por defecto de las plantillas', () => {
    const message = MessageBuilder.template({
      to: '+525512345678',
      templateName: 'recordatorio_turno',
      bodyParams: ['Ana', 'jueves 27 de agosto, 7:00 a 9:00'],
    });
    expect(message.languageCode).toBe('es_MX');
    expect(message.bodyParams).toHaveLength(2);
  });
});
