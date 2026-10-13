import { AssignmentStatus, MaritalStatus, ParticipantStatus } from '@prisma/client';
import { createLocation, createParticipant, createShift } from '../../test/helpers/fixtures';
import { createFullTestContext, resetDatabase, TestContext } from '../../test/helpers/test-context';
import { NotificationService } from '../messaging/notification.service';
import { RemindersService } from '../messaging/reminders.service';
import { ReportsService } from '../reports/reports.service';
import { AssignmentsService } from '../scheduling/assignments.service';
import { RecurringAssignmentsService } from '../scheduling/recurring-assignments.service';
import { ParticipantsService } from './participants.service';

/** Martes 25 de agosto de 2026, 12:00 hora del centro de México. */
const NOW = new Date('2026-08-25T18:00:00.000Z');
const RANGO_INICIO = new Date('2026-08-24T00:00:00.000Z');
const RANGO_FIN = new Date('2026-09-06T23:59:59.000Z');

describe('Quien cubre sin estar en el padrón (integración)', () => {
  let ctx: TestContext;
  let participantes: ParticipantsService;
  let assignments: AssignmentsService;
  let reports: ReportsService;
  let recurring: RecurringAssignmentsService;
  let notifications: NotificationService;
  let reminders: RemindersService;
  let locationId: string;

  beforeAll(async () => {
    ctx = await createFullTestContext();
    participantes = ctx.module.get(ParticipantsService);
    assignments = ctx.module.get(AssignmentsService);
    reports = ctx.module.get(ReportsService);
    recurring = ctx.module.get(RecurringAssignmentsService);
    notifications = ctx.module.get(NotificationService);
    reminders = ctx.module.get(RemindersService);
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    ctx.time.setClock(() => NOW);
    const location = await createLocation(ctx.prisma, {
      minCapacity: 2,
      settings: { messagingMode: 'live', broadcastCoverageToParticipants: true },
    });
    locationId = location.id;
  });

  const admin = { actorId: 'admin-1', actorName: 'Elena Mora' };

  /** Alguien de fuera, ya resuelto. */
  function invitada(extra: Partial<{ phone: string }> = {}) {
    return participantes.findOrCreateExternal({
      firstName: 'Sara',
      paternalSurname: 'Vega',
      phone: extra.phone ?? '55 7000 1111',
      locationId,
      ...admin,
    });
  }

  describe('el registro mínimo', () => {
    it('se crea sin membresía y sin consentimiento', async () => {
      const sara = await invitada();

      expect(sara.external).toBe(true);
      expect(sara.phoneE164).toBe('+525570001111');
      // Sin membresía es lo que la mantiene fuera de todos los listados del
      // punto; sin consentimiento, fuera de toda la mensajería.
      expect(await ctx.prisma.locationMembership.count({ where: { participantId: sara.id } })).toBe(
        0,
      );
      expect(sara.optInAt).toBeNull();
      expect(sara.status).toBe(ParticipantStatus.ACTIVE);
    });

    it('reutiliza el registro cuando vuelve a cubrir', async () => {
      const primera = await invitada();
      const segunda = await invitada();

      expect(segunda.id).toBe(primera.id);
      expect(await ctx.prisma.participant.count({ where: { external: true } })).toBe(1);
    });

    it('rechaza el teléfono de alguien del padrón, nombrándola', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López Pérez');

      await expect(
        participantes.findOrCreateExternal({
          firstName: 'Otra',
          paternalSurname: 'Persona',
          phone: ana.phoneE164,
          locationId,
          ...admin,
        }),
      ).rejects.toThrow(/López Pérez, Ana.*sí está en el padrón/);
    });

    it('rechaza un teléfono inválido con un mensaje claro', async () => {
      await expect(
        participantes.findOrCreateExternal({
          firstName: 'Sara',
          paternalSurname: 'Vega',
          phone: '123',
          locationId,
          ...admin,
        }),
      ).rejects.toThrow(/no es válido/);
    });
  });

  describe('no aparece donde no debe', () => {
    it('no está en el padrón del punto', async () => {
      await createParticipant(ctx.prisma, locationId, 'Ana López');
      await invitada();

      const padron = await ctx.prisma.participant.findMany({
        where: { memberships: { some: { locationId, active: true } } },
      });
      expect(padron.map((p) => p.firstName)).toEqual(['Ana']);
    });

    it('no se ofrece como titular de un turno fijo', async () => {
      const sara = await invitada();
      const plantilla = await ctx.prisma.shiftTemplate.create({
        data: {
          locationId,
          weekday: 3,
          startMinute: 7 * 60,
          endMinute: 9 * 60,
          capacity: 3,
          weekOfMonth: 0,
        },
      });

      const candidatos = await recurring.candidatesFor(plantilla.id, locationId);
      expect(candidatos.map((c) => c.id)).not.toContain(sara.id);
    });

    it('no se ofrece como cónyuge', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López');
      const sara = await invitada();

      const candidatos = await participantes.spouseCandidates(ana.id, locationId);
      expect(candidatos.map((c) => c.id)).not.toContain(sara.id);
    });

    it('no entra en la audiencia de una difusión de vacantes', async () => {
      await createParticipant(ctx.prisma, locationId, 'Ana López');
      const sara = await invitada();

      const audiencia = await notifications.broadcastAudience(locationId, []);
      expect(audiencia.map((p) => p.id)).not.toContain(sara.id);
    });

    it('no recibe recordatorio de su propio turno', async () => {
      // El caso que descubrió la fuga: tiene turno mañana, pero nadie le ha
      // pedido consentimiento para escribirle.
      const sara = await invitada();
      await createShift(ctx.prisma, locationId, {
        startsAt: new Date('2026-08-26T13:00:00.000Z'),
        participantIds: [sara.id],
      });

      expect(await reminders.dispatchDue()).toBe(0);
      expect(await ctx.prisma.outboxMessage.count({ where: { participantId: sara.id } })).toBe(0);
    });
  });

  describe('volver a elegirla', () => {
    /** Lo mismo que consulta el endpoint de candidatos del tablero. */
    function candidatosDe(location: string, shiftId: string) {
      return ctx.prisma.participant.findMany({
        where: {
          status: 'ACTIVE',
          OR: [
            { memberships: { some: { locationId: location, active: true } } },
            { external: true, assignments: { some: { shift: { locationId: location } } } },
          ],
          NOT: {
            assignments: { some: { shiftId, status: { in: ['ASSIGNED', 'CONFIRMED'] } } },
          },
        },
        select: { id: true, external: true },
      });
    }

    it('aparece como candidata en el punto donde ya cubrió', async () => {
      const sara = await invitada();
      const cubierto = await createShift(ctx.prisma, locationId, {
        startsAt: new Date('2026-08-30T13:00:00.000Z'),
        participantIds: [sara.id],
      });
      const otroTurno = await createShift(ctx.prisma, locationId, {
        startsAt: new Date('2026-08-31T13:00:00.000Z'),
        participantIds: [],
      });

      const candidatos = await candidatosDe(locationId, otroTurno.id);
      const suya = candidatos.find((c) => c.id === sara.id);
      expect(suya).toBeDefined();
      expect(suya!.external).toBe(true);
      // Y no se ofrece en el turno que ya está cubriendo.
      expect((await candidatosDe(locationId, cubierto.id)).map((c) => c.id)).not.toContain(sara.id);
    });

    it('NO aparece en un punto donde nunca ha cubierto', async () => {
      // El acotado por asignación es lo que evita que cada invitado creado
      // aparezca en todos los puntos para siempre.
      const sara = await invitada();
      await createShift(ctx.prisma, locationId, {
        startsAt: new Date('2026-08-30T13:00:00.000Z'),
        participantIds: [sara.id],
      });

      const otro = await createLocation(ctx.prisma);
      const turnoAjeno = await createShift(ctx.prisma, otro.id, {
        startsAt: new Date('2026-08-30T13:00:00.000Z'),
        participantIds: [],
      });

      expect((await candidatosDe(otro.id, turnoAjeno.id)).map((c) => c.id)).not.toContain(sara.id);
    });

    it('antes de cubrir nada, no aparece en ningún punto', async () => {
      const sara = await invitada();
      const turno = await createShift(ctx.prisma, locationId, {
        startsAt: new Date('2026-08-30T13:00:00.000Z'),
        participantIds: [],
      });

      expect((await candidatosDe(locationId, turno.id)).map((c) => c.id)).not.toContain(sara.id);
    });
  });

  describe('en el turno cuenta como cualquiera', () => {
    it('ocupa un lugar y completa el turno', async () => {
      const gente = await Promise.all(
        ['Ana López', 'Beto Ruiz'].map((n) => createParticipant(ctx.prisma, locationId, n)),
      );
      const shift = await createShift(ctx.prisma, locationId, {
        startsAt: new Date('2026-08-30T13:00:00.000Z'),
        capacity: 3,
        participantIds: gente.map((p) => p.id),
      });
      const sara = await invitada();

      await assignments.assignManually({
        shiftId: shift.id,
        participantId: sara.id,
        note: 'la trajo Dora',
        ...admin,
      });

      const turno = (await reports.dashboard(locationId, RANGO_INICIO, RANGO_FIN)).days[0]
        .shifts[0];
      expect(turno.occupied).toBe(3);
      expect(turno.need).toBe('ok');
      const suya = turno.participants.find((p) => p.participantId === sara.id)!;
      expect(suya.name).toBe('Sara Vega');
      expect(suya.note).toBe('la trajo Dora');
    });

    it('cada ocasión conserva su propia nota', async () => {
      const sara = await invitada();
      const uno = await createShift(ctx.prisma, locationId, {
        startsAt: new Date('2026-08-30T13:00:00.000Z'),
        participantIds: [],
      });
      const dos = await createShift(ctx.prisma, locationId, {
        startsAt: new Date('2026-08-31T13:00:00.000Z'),
        participantIds: [],
      });

      await assignments.assignManually({
        shiftId: uno.id,
        participantId: sara.id,
        note: 'la trajo Dora',
        ...admin,
      });
      await assignments.assignManually({
        shiftId: dos.id,
        participantId: sara.id,
        note: 'vino con su esposo',
        ...admin,
      });

      const notas = await ctx.prisma.assignment.findMany({
        where: { participantId: sara.id },
        orderBy: { shift: { startsAt: 'asc' } },
        select: { note: true },
      });
      expect(notas.map((n) => n.note)).toEqual(['la trajo Dora', 'vino con su esposo']);
      // Y una sola persona, no dos.
      expect(await ctx.prisma.participant.count({ where: { external: true } })).toBe(1);
    });

    it('se le puede cancelar como a cualquiera', async () => {
      const sara = await invitada();
      const shift = await createShift(ctx.prisma, locationId, {
        startsAt: new Date('2026-08-30T13:00:00.000Z'),
        participantIds: [sara.id],
      });
      const suya = await ctx.prisma.assignment.findFirstOrThrow({
        where: { shiftId: shift.id, participantId: sara.id },
      });

      await assignments.cancel({ assignmentId: suya.id, reasonCode: 'otro', ...admin });

      const despues = await ctx.prisma.assignment.findUniqueOrThrow({ where: { id: suya.id } });
      expect(despues.status).toBe(AssignmentStatus.CANCELLED);
      expect(despues.cancelledByName).toBe('Elena Mora');
    });

    it('no se le puede casar: el estado civil es cosa del padrón', async () => {
      // No es una regla nueva, es la que ya existe: sin membresía no sale como
      // candidata, y aquí se comprueba que tampoco por la puerta de atrás.
      const sara = await invitada();
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López');

      const candidatos = await participantes.spouseCandidates(ana.id, locationId);
      expect(candidatos.map((c) => c.id)).not.toContain(sara.id);
      expect(sara.maritalStatus).toBe(MaritalStatus.SIN_REGISTRAR);
    });
  });
});
