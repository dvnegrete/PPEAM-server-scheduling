import { AssignmentStatus, ParticipantStatus } from '@prisma/client';
import { createLocation, createParticipant, createShift } from '../../test/helpers/fixtures';
import { createFullTestContext, resetDatabase, TestContext } from '../../test/helpers/test-context';
import { OutgoingMessage } from '../whatsapp/types/message.types';
import { RemindersService } from './reminders.service';

/** Martes 25 de agosto de 2026, 12:00 hora del centro de México. */
const NOW = new Date('2026-08-25T18:00:00.000Z');

describe('Recordatorios de turno (integración)', () => {
  let ctx: TestContext;
  let reminders: RemindersService;

  beforeAll(async () => {
    ctx = await createFullTestContext();
    reminders = ctx.module.get(RemindersService);
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    ctx.time.setClock(() => NOW);
  });

  async function messagesFor(phone: string): Promise<OutgoingMessage[]> {
    const rows = await ctx.prisma.outboxMessage.findMany({ where: { toPhone: phone } });
    return rows.map((row) => row.payload as unknown as OutgoingMessage);
  }

  it('recuerda los turnos de entre semana el día anterior', async () => {
    const location = await createLocation(ctx.prisma);
    const ana = await createParticipant(ctx.prisma, location.id, 'Ana');
    // Miércoles 26 de agosto: es mañana.
    await createShift(ctx.prisma, location.id, {
      startsAt: new Date('2026-08-26T13:00:00.000Z'),
      participantIds: [ana.id],
    });

    const sent = await reminders.dispatchDue();

    expect(sent).toBe(1);
    const mensajes = await messagesFor(ana.phoneE164);
    expect(mensajes).toHaveLength(1);
    expect(JSON.stringify(mensajes[0])).toContain('recordatorio_turno');
  });

  it('no recuerda todavía un turno de entre semana lejano', async () => {
    const location = await createLocation(ctx.prisma);
    const ana = await createParticipant(ctx.prisma, location.id, 'Ana');
    // Jueves 27: falta más de un día.
    await createShift(ctx.prisma, location.id, {
      startsAt: new Date('2026-08-27T13:00:00.000Z'),
      participantIds: [ana.id],
    });

    expect(await reminders.dispatchDue()).toBe(0);
  });

  it('recuerda los turnos de fin de semana con una semana de anticipación', async () => {
    const location = await createLocation(ctx.prisma);
    const ana = await createParticipant(ctx.prisma, location.id, 'Ana');
    // Martes 25 + 7 días = martes 1 de septiembre... el sábado es el 29 de agosto,
    // así que se prueba con el sábado que cae exactamente a siete días: 1 de sep. no
    // es fin de semana. Se usa el sábado 5 de septiembre desde el sábado 29 de agosto.
    ctx.time.setClock(() => new Date('2026-08-29T18:00:00.000Z'));
    await createShift(ctx.prisma, location.id, {
      startsAt: new Date('2026-09-05T13:00:00.000Z'),
      participantIds: [ana.id],
    });

    const sent = await reminders.dispatchDue();

    expect(sent).toBe(1);
  });

  it('no manda dos veces el mismo recordatorio', async () => {
    const location = await createLocation(ctx.prisma);
    const ana = await createParticipant(ctx.prisma, location.id, 'Ana');
    await createShift(ctx.prisma, location.id, {
      startsAt: new Date('2026-08-26T13:00:00.000Z'),
      participantIds: [ana.id],
    });

    await reminders.dispatchDue();
    const segunda = await reminders.dispatchDue();

    expect(segunda).toBe(0);
    expect(await messagesFor(ana.phoneE164)).toHaveLength(1);
  });

  it('no molesta a quien ya confirmó', async () => {
    const location = await createLocation(ctx.prisma);
    const ana = await createParticipant(ctx.prisma, location.id, 'Ana');
    const shift = await createShift(ctx.prisma, location.id, {
      startsAt: new Date('2026-08-26T13:00:00.000Z'),
      participantIds: [ana.id],
    });
    await ctx.prisma.assignment.updateMany({
      where: { shiftId: shift.id },
      data: { status: AssignmentStatus.CONFIRMED },
    });

    expect(await reminders.dispatchDue()).toBe(0);
  });

  it('no escribe a quien no ha dado consentimiento', async () => {
    // `sendToParticipant` no comprueba estado ni opt-in —solo `send()` lo hace—,
    // así que este era el único camino por el que alguien sin consentimiento
    // podía recibir un mensaje. Es el caso de quien cubre sin estar en el padrón.
    const location = await createLocation(ctx.prisma);
    const ana = await createParticipant(ctx.prisma, location.id, 'Ana López');
    const beto = await createParticipant(ctx.prisma, location.id, 'Beto Ruiz');
    await ctx.prisma.participant.update({ where: { id: beto.id }, data: { optInAt: null } });
    await createShift(ctx.prisma, location.id, {
      startsAt: new Date('2026-08-26T13:00:00.000Z'),
      participantIds: [ana.id, beto.id],
    });

    const sent = await reminders.dispatchDue();

    expect(sent).toBe(1);
    expect(await messagesFor(ana.phoneE164)).toHaveLength(1);
    expect(await messagesFor(beto.phoneE164)).toHaveLength(0);
    // Y su asignación no queda marcada como recordada, para que no se dé por
    // avisado si más adelante sí consiente.
    const suya = await ctx.prisma.assignment.findFirstOrThrow({
      where: { participantId: beto.id },
    });
    expect(suya.remindedAt).toBeNull();
  });

  it('tampoco escribe a quien está pausado', async () => {
    const location = await createLocation(ctx.prisma);
    const ana = await createParticipant(ctx.prisma, location.id, 'Ana López');
    await ctx.prisma.participant.update({
      where: { id: ana.id },
      data: { status: ParticipantStatus.PAUSED },
    });
    await createShift(ctx.prisma, location.id, {
      startsAt: new Date('2026-08-26T13:00:00.000Z'),
      participantIds: [ana.id],
    });

    expect(await reminders.dispatchDue()).toBe(0);
    expect(await messagesFor(ana.phoneE164)).toHaveLength(0);
  });

  it('no recuerda turnos cancelados', async () => {
    const location = await createLocation(ctx.prisma);
    const ana = await createParticipant(ctx.prisma, location.id, 'Ana');
    const shift = await createShift(ctx.prisma, location.id, {
      startsAt: new Date('2026-08-26T13:00:00.000Z'),
      participantIds: [ana.id],
    });
    await ctx.prisma.shift.update({ where: { id: shift.id }, data: { status: 'CANCELLED' } });

    expect(await reminders.dispatchDue()).toBe(0);
  });

  it('espera a la hora configurada para enviar', async () => {
    const location = await createLocation(ctx.prisma, { settings: { reminderHourLocal: 9 } });
    const ana = await createParticipant(ctx.prisma, location.id, 'Ana');
    await createShift(ctx.prisma, location.id, {
      startsAt: new Date('2026-08-26T13:00:00.000Z'),
      participantIds: [ana.id],
    });

    // 6:00 hora local: todavía no toca.
    ctx.time.setClock(() => new Date('2026-08-25T12:00:00.000Z'));
    expect(await reminders.dispatchDue()).toBe(0);

    // 10:00 hora local: ya pasó la hora configurada.
    ctx.time.setClock(() => new Date('2026-08-25T16:00:00.000Z'));
    expect(await reminders.dispatchDue()).toBe(1);
  });

  it('el recordatorio ofrece confirmar o avisar que no se podrá', async () => {
    const location = await createLocation(ctx.prisma);
    const ana = await createParticipant(ctx.prisma, location.id, 'Ana');
    const shift = await createShift(ctx.prisma, location.id, {
      startsAt: new Date('2026-08-26T13:00:00.000Z'),
      participantIds: [ana.id],
    });
    const assignment = await ctx.prisma.assignment.findFirstOrThrow({
      where: { shiftId: shift.id },
    });

    await reminders.dispatchDue();

    const mensaje = (await messagesFor(ana.phoneE164))[0];
    expect(mensaje.kind).toBe('TEMPLATE');
    if (mensaje.kind === 'TEMPLATE') {
      expect(mensaje.buttonPayloads).toEqual([
        `CONFIRMO:${assignment.id}`,
        `NO_PODRE:${assignment.id}`,
      ]);
    }
  });
});
