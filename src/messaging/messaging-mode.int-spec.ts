import { createLocation, createParticipant, createShift } from '../../test/helpers/fixtures';
import { createFullTestContext, resetDatabase, TestContext } from '../../test/helpers/test-context';
import { AssignmentsService } from '../scheduling/assignments.service';
import { CoverageService } from '../scheduling/coverage.service';
import { MessageBuilder } from '../whatsapp/message-builder';
import { NotificationService } from './notification.service';

const NOW = new Date('2026-08-25T18:00:00.000Z');

/**
 * Con una cuenta de prueba de Meta solo se puede escribir a los números dados de
 * alta. Enviar a cualquier otro se rechaza, así que más vale no encolarlo.
 */
describe('Modo de mensajería restringido (integración)', () => {
  let ctx: TestContext;
  let notifications: NotificationService;
  let assignments: AssignmentsService;
  let coverage: CoverageService;

  beforeAll(async () => {
    ctx = await createFullTestContext();
    notifications = ctx.module.get(NotificationService);
    assignments = ctx.module.get(AssignmentsService);
    coverage = ctx.module.get(CoverageService);
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    ctx.time.setClock(() => NOW);
  });

  const aviso = {
    interactive: (to: string) => MessageBuilder.text(to, 'Aviso de prueba'),
    template: { name: 'aviso_encargado', params: ['Aviso de prueba'] },
  };

  async function encolados(phone: string): Promise<number> {
    return ctx.prisma.outboxMessage.count({ where: { toPhone: phone } });
  }

  it('entrega a un número dado de alta en la cuenta de prueba', async () => {
    const location = await createLocation(ctx.prisma);
    const elena = await createParticipant(ctx.prisma, location.id, 'Elena Mora');
    await ctx.prisma.location.update({
      where: { id: location.id },
      data: { settings: { messagingMode: 'test', allowedRecipients: [elena.phoneE164] } },
    });

    await notifications.send(elena.id, aviso);

    expect(await encolados(elena.phoneE164)).toBe(1);
  });

  it('omite a quien no está en la lista, en vez de encolar un envío condenado a fallar', async () => {
    const location = await createLocation(ctx.prisma);
    const elena = await createParticipant(ctx.prisma, location.id, 'Elena Mora');
    const ana = await createParticipant(ctx.prisma, location.id, 'Ana López');
    await ctx.prisma.location.update({
      where: { id: location.id },
      data: { settings: { messagingMode: 'test', allowedRecipients: [elena.phoneE164] } },
    });

    const entregado = await notifications.send(ana.id, aviso);

    expect(entregado).toBe(false);
    expect(await encolados(ana.phoneE164)).toBe(0);
  });

  it('reconoce el número aunque la lista lo traiga con el «1» que agrega WhatsApp', async () => {
    const location = await createLocation(ctx.prisma);
    const elena = await ctx.prisma.participant.create({
      data: {
        firstName: 'Elena',
        paternalSurname: 'Mora',
        phoneE164: '+525512340001',
        optInAt: NOW,
      },
    });
    await ctx.prisma.locationMembership.create({
      data: { locationId: location.id, participantId: elena.id },
    });
    await ctx.prisma.location.update({
      where: { id: location.id },
      // Así es como Meta muestra los números mexicanos en su consola.
      data: { settings: { messagingMode: 'test', allowedRecipients: ['+5215512340001'] } },
    });

    await notifications.send(elena.id, aviso);

    expect(await encolados('+525512340001')).toBe(1);
  });

  it('en modo activo entrega a todos, sin lista blanca', async () => {
    const location = await createLocation(ctx.prisma);
    const ana = await createParticipant(ctx.prisma, location.id, 'Ana López');
    await ctx.prisma.location.update({
      where: { id: location.id },
      data: { settings: { messagingMode: 'live' } },
    });

    await notifications.send(ana.id, aviso);

    expect(await encolados(ana.phoneE164)).toBe(1);
  });

  it('abrir una vacante no difunde nada mientras la convocatoria sea por encuesta', async () => {
    const location = await createLocation(ctx.prisma);
    const gente = await Promise.all(
      ['Ana', 'Beto', 'Carla', 'Dora'].map((nombre) =>
        createParticipant(ctx.prisma, location.id, nombre),
      ),
    );
    await ctx.prisma.location.update({
      where: { id: location.id },
      data: {
        settings: {
          messagingMode: 'test',
          allowedRecipients: gente.map((p) => p.phoneE164),
          broadcastCoverageToParticipants: false,
        },
      },
    });
    const shift = await createShift(ctx.prisma, location.id, {
      startsAt: new Date('2026-08-30T13:00:00.000Z'),
      capacity: 3,
      participantIds: gente.slice(0, 3).map((p) => p.id),
    });
    const asignacion = await ctx.prisma.assignment.findFirstOrThrow({
      where: { shiftId: shift.id, participantId: gente[0].id },
    });

    await assignments.cancel({ assignmentId: asignacion.id });

    // La vacante sí queda abierta: es lo que alimenta el tablero y la encuesta.
    const vacante = await ctx.prisma.coverageRequest.findFirstOrThrow();
    expect(vacante.status).toBe('OPEN');
    // Pero nadie recibió un mensaje por ella.
    expect(await encolados(gente[3].phoneE164)).toBe(0);
  });

  it('con la difusión encendida sí avisa a los participantes autorizados', async () => {
    const location = await createLocation(ctx.prisma);
    const gente = await Promise.all(
      ['Ana', 'Beto', 'Carla', 'Dora'].map((nombre) =>
        createParticipant(ctx.prisma, location.id, nombre),
      ),
    );
    await ctx.prisma.location.update({
      where: { id: location.id },
      data: {
        settings: {
          messagingMode: 'test',
          allowedRecipients: gente.map((p) => p.phoneE164),
          broadcastCoverageToParticipants: true,
        },
      },
    });
    // Dos de tres lugares ocupados: queda uno libre que difundir.
    const shift = await createShift(ctx.prisma, location.id, {
      startsAt: new Date('2026-08-30T13:00:00.000Z'),
      capacity: 3,
      participantIds: gente.slice(0, 2).map((p) => p.id),
    });

    await coverage.openForShift(shift.id);

    expect(await encolados(gente[3].phoneE164)).toBe(1);
  });
});
