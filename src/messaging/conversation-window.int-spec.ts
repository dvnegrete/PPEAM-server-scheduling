import { createLocation, createParticipant } from '../../test/helpers/fixtures';
import { createFullTestContext, resetDatabase, TestContext } from '../../test/helpers/test-context';
import { ConversationWindowService } from './conversation-window.service';

/** Reloj fijo: martes 25 de agosto de 2026, 12:00 hora del centro de México. */
const NOW = new Date('2026-08-25T18:00:00.000Z');
const HORA = 3_600_000;

describe('Ventana de servicio de WhatsApp (integración)', () => {
  let ctx: TestContext;
  let ventana: ConversationWindowService;
  let locationId: string;

  beforeAll(async () => {
    ctx = await createFullTestContext();
    ventana = ctx.module.get(ConversationWindowService);
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    ctx.time.setClock(() => NOW);
    const location = await createLocation(ctx.prisma);
    locationId = location.id;
  });

  /** Un mensaje de entrada ya atribuido a alguien, recibido hace `haceHoras`. */
  async function mensajeDeEntrada(participantId: string, haceHoras: number, fromPhone = '+52551') {
    return ctx.prisma.inboundMessage.create({
      data: {
        waMessageId: `wamid.${participantId}.${haceHoras}`,
        fromPhone,
        participantId,
        type: 'text',
        payload: {},
        receivedAt: new Date(NOW.getTime() - haceHoras * HORA),
      },
    });
  }

  it('está cerrada para quien nunca ha escrito', async () => {
    const ana = await createParticipant(ctx.prisma, locationId, 'Ana López');
    expect(await ventana.isOpen(ana.id)).toBe(false);
  });

  it('está abierta si escribió hace poco', async () => {
    const ana = await createParticipant(ctx.prisma, locationId, 'Ana López');
    await mensajeDeEntrada(ana.id, 2);

    expect(await ventana.isOpen(ana.id)).toBe(true);
  });

  it('se cierra pasadas las 24 horas', async () => {
    const ana = await createParticipant(ctx.prisma, locationId, 'Ana López');
    await mensajeDeEntrada(ana.id, 25);

    expect(await ventana.isOpen(ana.id)).toBe(false);
  });

  describe('tras un cambio de número', () => {
    it('no cuenta lo que llegó al número anterior', async () => {
      // La ventana es del número, no de la persona. El número nuevo nace sin
      // historial, por más que ella llevara años escribiendo: creer lo contrario
      // hace que el sistema mande un mensaje libre que Meta rechaza en silencio.
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López');
      await mensajeDeEntrada(ana.id, 2, '+525500000001');

      expect(await ventana.isOpen(ana.id)).toBe(true);

      await ctx.prisma.participant.update({
        where: { id: ana.id },
        data: { phoneE164: '+525599998888', phoneChangedAt: new Date(NOW.getTime() - HORA) },
      });

      expect(await ventana.isOpen(ana.id)).toBe(false);
    });

    it('sí cuenta lo que llegó después del cambio', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López');
      await ctx.prisma.participant.update({
        where: { id: ana.id },
        data: { phoneChangedAt: new Date(NOW.getTime() - 5 * HORA) },
      });
      await mensajeDeEntrada(ana.id, 2);

      expect(await ventana.isOpen(ana.id)).toBe(true);
    });
  });

  describe('consulta en bloque', () => {
    it('devuelve el conjunto vacío sin participantes', async () => {
      expect(await ventana.openFor([])).toEqual(new Set());
    });

    it('distingue a quien cambió de número de quien no', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López');
      const beto = await createParticipant(ctx.prisma, locationId, 'Beto Ruiz');
      const carla = await createParticipant(ctx.prisma, locationId, 'Carla Díaz');

      // Los tres escribieron hace dos horas.
      await mensajeDeEntrada(ana.id, 2);
      await mensajeDeEntrada(beto.id, 2);
      await mensajeDeEntrada(carla.id, 2);

      // Beto cambió de número después de escribir; Carla, antes.
      await ctx.prisma.participant.update({
        where: { id: beto.id },
        data: { phoneChangedAt: new Date(NOW.getTime() - HORA) },
      });
      await ctx.prisma.participant.update({
        where: { id: carla.id },
        data: { phoneChangedAt: new Date(NOW.getTime() - 5 * HORA) },
      });

      const abiertos = await ventana.openFor([ana.id, beto.id, carla.id]);

      expect(abiertos.has(ana.id)).toBe(true);
      expect(abiertos.has(beto.id)).toBe(false);
      expect(abiertos.has(carla.id)).toBe(true);
    });

    it('coincide con la consulta individual', async () => {
      // Las difusiones usan `openFor` y las respuestas sueltas `isOpen`. Si las
      // dos no dicen lo mismo, la política de envío dependería del camino.
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López');
      await mensajeDeEntrada(ana.id, 2);
      await ctx.prisma.participant.update({
        where: { id: ana.id },
        data: { phoneChangedAt: new Date(NOW.getTime() - HORA) },
      });

      const abiertos = await ventana.openFor([ana.id]);
      expect(abiertos.has(ana.id)).toBe(await ventana.isOpen(ana.id));
      expect(abiertos.has(ana.id)).toBe(false);
    });
  });
});
