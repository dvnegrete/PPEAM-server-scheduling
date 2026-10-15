import { ActorType } from '@prisma/client';
import { createLocation, createParticipant, createShift } from '../../test/helpers/fixtures';
import { createFullTestContext, resetDatabase, TestContext } from '../../test/helpers/test-context';
import { AssignmentsService } from '../scheduling/assignments.service';
import { PollDraftService } from './poll-draft.service';
import { ReportsService } from './reports.service';

/** Martes 25 de agosto de 2026, 12:00 hora del centro de México. */
const NOW = new Date('2026-08-25T18:00:00.000Z');
const RANGO_INICIO = new Date('2026-08-24T00:00:00.000Z');
const RANGO_FIN = new Date('2026-09-06T23:59:59.000Z');

describe('Tablero de administradores (integración)', () => {
  let ctx: TestContext;
  let reports: ReportsService;
  let assignments: AssignmentsService;
  let poll: PollDraftService;

  beforeAll(async () => {
    ctx = await createFullTestContext();
    reports = ctx.module.get(ReportsService);
    assignments = ctx.module.get(AssignmentsService);
    poll = ctx.module.get(PollDraftService);
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    ctx.time.setClock(() => NOW);
  });

  /** Turno del domingo 30 de agosto a las 7:00, con los ocupantes indicados. */
  async function escenario(ocupantes = 3) {
    const location = await createLocation(ctx.prisma, { minCapacity: 2, defaultCapacity: 3 });
    const gente = await Promise.all(
      ['Ana López', 'Beto Ruiz', 'Carla Díaz', 'Dora Sosa', 'Elsa Vega'].map((nombre) =>
        createParticipant(ctx.prisma, location.id, nombre),
      ),
    );
    const shift = await createShift(ctx.prisma, location.id, {
      startsAt: new Date('2026-08-30T13:00:00.000Z'),
      capacity: 3,
      participantIds: gente.slice(0, ocupantes).map((p) => p.id),
    });
    return { location, gente, shift };
  }

  function admin(nombre = 'Elena Mora') {
    return { actorId: 'admin-1', actorType: ActorType.ADMIN, actorName: nombre };
  }

  describe('cancelación desde el panel', () => {
    it('registra el motivo y quién la capturó', async () => {
      const { shift, gente } = await escenario();
      const asignacion = await ctx.prisma.assignment.findFirstOrThrow({
        where: { shiftId: shift.id, participantId: gente[0].id },
      });

      await assignments.cancel({
        assignmentId: asignacion.id,
        ...admin(),
        reasonCode: 'enfermedad',
        reason: 'Avisó por mensaje al encargado',
      });

      const actualizada = await ctx.prisma.assignment.findUniqueOrThrow({
        where: { id: asignacion.id },
      });
      expect(actualizada.status).toBe('CANCELLED');
      expect(actualizada.cancelReasonCode).toBe('enfermedad');
      expect(actualizada.cancelReason).toBe('Avisó por mensaje al encargado');
      expect(actualizada.cancelledByName).toBe('Elena Mora');
      expect(actualizada.cancelledAt).not.toBeNull();

      const registro = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'assignment.cancelled' },
      });
      expect(registro.actorType).toBe('ADMIN');
      expect(registro.actorName).toBe('Elena Mora');
    });
  });

  describe('asignación manual', () => {
    it('sienta al participante y sella quién y cuándo lo registró', async () => {
      const { shift, gente } = await escenario(2);

      await assignments.assignManually({
        shiftId: shift.id,
        participantId: gente[3].id,
        ...admin(),
      });

      const asignacion = await ctx.prisma.assignment.findFirstOrThrow({
        where: { shiftId: shift.id, participantId: gente[3].id },
      });
      expect(asignacion.status).toBe('ASSIGNED');
      expect(asignacion.origin).toBe('COVERAGE');
      expect(asignacion.assignedByName).toBe('Elena Mora');
      expect(asignacion.assignedAt?.getTime()).toBe(NOW.getTime());
    });

    it('admite a una cuarta persona por encima del cupo', async () => {
      // El cupo es la meta, no el tope: un turno holgado no es un problema que
      // haya que impedir. El extra entra por decisión del administrador.
      const { shift, gente } = await escenario(3);

      await assignments.assignManually({
        shiftId: shift.id,
        participantId: gente[3].id,
        ...admin(),
      });

      expect(
        await ctx.prisma.assignment.count({
          where: { shiftId: shift.id, status: { in: ['ASSIGNED', 'CONFIRMED'] } },
        }),
      ).toBe(4);
    });

    it('rechaza a la quinta, que pasa del tope del punto', async () => {
      const { shift, gente } = await escenario(3);
      await assignments.assignManually({
        shiftId: shift.id,
        participantId: gente[3].id,
        ...admin(),
      });

      await expect(
        assignments.assignManually({
          shiftId: shift.id,
          participantId: gente[4].id,
          ...admin(),
        }),
      ).rejects.toThrow(/máximo del punto/);
    });

    it('sin margen entre cupo y tope, no hay lugar extra', async () => {
      const location = await createLocation(ctx.prisma, {
        minCapacity: 2,
        defaultCapacity: 3,
        maxCapacity: 3,
      });
      const gente = await Promise.all(
        ['Ana López', 'Beto Ruiz', 'Carla Díaz', 'Dora Sosa'].map((nombre) =>
          createParticipant(ctx.prisma, location.id, nombre),
        ),
      );
      const shift = await createShift(ctx.prisma, location.id, {
        startsAt: new Date('2026-08-30T13:00:00.000Z'),
        capacity: 3,
        participantIds: gente.slice(0, 3).map((p) => p.id),
      });

      await expect(
        assignments.assignManually({
          shiftId: shift.id,
          participantId: gente[3].id,
          ...admin(),
        }),
      ).rejects.toThrow(/máximo del punto/);
    });

    it('rechaza asignar a quien ya tiene lugar', async () => {
      const { shift, gente } = await escenario(2);

      await expect(
        assignments.assignManually({
          shiftId: shift.id,
          participantId: gente[0].id,
          ...admin(),
        }),
      ).rejects.toThrow(/ya tiene lugar/);
    });

    it('con dos registros simultáneos para el último lugar, entra uno solo', async () => {
      // El turno arranca completo para su meta de 3, así que solo queda el lugar
      // extra: el bloqueo de fila es lo que impide que dos administradores
      // registrando a la vez dejen cinco personas donde el tope son cuatro.
      const { shift, gente } = await escenario(3);

      const resultados = await Promise.allSettled([
        assignments.assignManually({ shiftId: shift.id, participantId: gente[3].id, ...admin() }),
        assignments.assignManually({ shiftId: shift.id, participantId: gente[4].id, ...admin() }),
      ]);

      expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        await ctx.prisma.assignment.count({
          where: { shiftId: shift.id, status: { in: ['ASSIGNED', 'CONFIRMED'] } },
        }),
      ).toBe(4);
    });

    it('al volver a asignar a quien canceló, la fecha refleja el movimiento nuevo', async () => {
      const { shift, gente } = await escenario(3);
      const asignacion = await ctx.prisma.assignment.findFirstOrThrow({
        where: { shiftId: shift.id, participantId: gente[0].id },
      });
      const creadaOriginalmente = asignacion.createdAt;

      await assignments.cancel({ assignmentId: asignacion.id, ...admin(), reasonCode: 'trabajo' });

      // Dos horas después, esa misma persona vuelve a poder.
      const despues = new Date(NOW.getTime() + 2 * 3_600_000);
      ctx.time.setClock(() => despues);
      await assignments.assignManually({
        shiftId: shift.id,
        participantId: gente[0].id,
        ...admin('Felipe Cruz'),
      });

      const reutilizada = await ctx.prisma.assignment.findUniqueOrThrow({
        where: { id: asignacion.id },
      });
      // La fila es la misma —el índice único lo obliga— pero la trazabilidad
      // corresponde al movimiento vigente, no al registro original.
      expect(reutilizada.createdAt.getTime()).toBe(creadaOriginalmente.getTime());
      expect(reutilizada.assignedAt?.getTime()).toBe(despues.getTime());
      expect(reutilizada.assignedByName).toBe('Felipe Cruz');
      expect(reutilizada.cancelledAt).toBeNull();
      expect(reutilizada.cancelReasonCode).toBeNull();
    });
  });

  describe('estado de los turnos', () => {
    it('clasifica según el cupo y el mínimo operativo', async () => {
      const { location, shift, gente } = await escenario(3);

      const completo = await reports.dashboard(location.id, RANGO_INICIO, RANGO_FIN);
      expect(completo.days[0].shifts[0].need).toBe('ok');

      const primera = await ctx.prisma.assignment.findFirstOrThrow({
        where: { shiftId: shift.id, participantId: gente[0].id },
      });
      await assignments.cancel({ assignmentId: primera.id, ...admin(), reasonCode: 'otro' });

      const bajoCupo = await reports.dashboard(location.id, RANGO_INICIO, RANGO_FIN);
      expect(bajoCupo.days[0].shifts[0].need).toBe('bajoCupo');
      expect(bajoCupo.summary.understaffed).toBe(1);

      const segunda = await ctx.prisma.assignment.findFirstOrThrow({
        where: { shiftId: shift.id, participantId: gente[1].id },
      });
      await assignments.cancel({ assignmentId: segunda.id, ...admin(), reasonCode: 'viaje' });

      const bajoMinimo = await reports.dashboard(location.id, RANGO_INICIO, RANGO_FIN);
      expect(bajoMinimo.days[0].shifts[0].need).toBe('bajoMinimo');
      expect(bajoMinimo.summary.critical).toBe(1);
      expect(bajoMinimo.summary.cancellations).toBe(2);
    });

    it('un turno con una persona extra sigue completo y no cuenta como incompleto', async () => {
      // Es la prueba que protege la decisión de diseño: el lugar extra no puede
      // volver ámbar un turno que ya cumplió su meta, ni inflar el recuento de
      // turnos incompletos del resumen. Si alguien cambiara `needLevel` para
      // mirar el tope en vez del cupo, esto falla.
      const { location, shift, gente } = await escenario(3);
      await assignments.assignManually({
        shiftId: shift.id,
        participantId: gente[3].id,
        ...admin(),
      });

      const tablero = await reports.dashboard(location.id, RANGO_INICIO, RANGO_FIN);
      const turno = tablero.days[0].shifts[0];

      expect(turno.occupied).toBe(4);
      expect(turno.capacity).toBe(3);
      expect(turno.need).toBe('ok');
      expect(tablero.summary.understaffed).toBe(0);
      expect(tablero.summary.critical).toBe(0);
      // Y no quedan lugares que convocar ni más extra que ofrecer.
      expect(turno.freeSlots).toBe(0);
      expect(turno.extraSlots).toBe(0);
      expect(shift.capacity).toBe(3);
    });

    it('informa del lugar extra disponible sin contarlo como hueco', async () => {
      const { location } = await escenario(3);

      const turno = (await reports.dashboard(location.id, RANGO_INICIO, RANGO_FIN)).days[0]
        .shifts[0];

      // Completo para la meta: nada que convocar, pero admite uno más.
      expect(turno.freeSlots).toBe(0);
      expect(turno.extraSlots).toBe(1);
    });

    it('el extra se mide desde la meta, no desde la ocupación', async () => {
      // Con 2 de 3 falta 1 por convocar y hay 1 extra detrás, no 2.
      const { location } = await escenario(2);

      const turno = (await reports.dashboard(location.id, RANGO_INICIO, RANGO_FIN)).days[0]
        .shifts[0];

      expect(turno.freeSlots).toBe(1);
      expect(turno.extraSlots).toBe(1);
    });

    it('trae el vínculo matrimonial, para poder emparejar a los cónyuges del turno', async () => {
      // Es lo que permite al panel ofrecer «cancelar también a su cónyuge» sin
      // ninguna consulta extra: si los dos están en el turno, los dos vienen ya
      // en esta misma lista.
      const { location, gente } = await escenario(3);
      await ctx.prisma.participant.update({
        where: { id: gente[0].id },
        data: { maritalStatus: 'CASADO', spouseId: gente[1].id },
      });
      await ctx.prisma.participant.update({
        where: { id: gente[1].id },
        data: { maritalStatus: 'CASADO', spouseId: gente[0].id },
      });

      const turno = (await reports.dashboard(location.id, RANGO_INICIO, RANGO_FIN)).days[0]
        .shifts[0];
      const primera = turno.participants.find((p) => p.participantId === gente[0].id)!;
      const tercera = turno.participants.find((p) => p.participantId === gente[2].id)!;

      expect(primera.spouseId).toBe(gente[1].id);
      expect(tercera.spouseId).toBeNull();
    });

    it('muestra quién cubre y quién canceló, con sus fechas y responsables', async () => {
      const { location, shift, gente } = await escenario(3);
      const asignacion = await ctx.prisma.assignment.findFirstOrThrow({
        where: { shiftId: shift.id, participantId: gente[0].id },
      });

      await assignments.cancel({
        assignmentId: asignacion.id,
        ...admin('Elena Mora'),
        reasonCode: 'enfermedad',
      });
      await assignments.assignManually({
        shiftId: shift.id,
        participantId: gente[3].id,
        ...admin('Felipe Cruz'),
      });

      const tablero = await reports.dashboard(location.id, RANGO_INICIO, RANGO_FIN);
      const turno = tablero.days[0].shifts[0];

      const cobertura = turno.participants.find((p) => p.name === 'Dora Sosa');
      expect(cobertura).toMatchObject({ origin: 'COVERAGE', assignedByName: 'Felipe Cruz' });
      expect(cobertura?.assignedAt).not.toBeNull();

      expect(turno.cancellations).toHaveLength(1);
      expect(turno.cancellations[0]).toMatchObject({
        name: 'Ana López',
        reasonCode: 'enfermedad',
        cancelledByName: 'Elena Mora',
      });
      expect(turno.need).toBe('ok');
    });

    it('agrupa los turnos por día', async () => {
      const location = await createLocation(ctx.prisma);
      await createShift(ctx.prisma, location.id, {
        startsAt: new Date('2026-08-30T13:00:00.000Z'),
        startMinute: 7 * 60,
      });
      await createShift(ctx.prisma, location.id, {
        startsAt: new Date('2026-08-30T15:00:00.000Z'),
        startMinute: 9 * 60,
      });
      await createShift(ctx.prisma, location.id, {
        startsAt: new Date('2026-08-31T13:00:00.000Z'),
        startMinute: 7 * 60,
      });

      const tablero = await reports.dashboard(location.id, RANGO_INICIO, RANGO_FIN);
      expect(tablero.days).toHaveLength(2);
      expect(tablero.days[0].shifts).toHaveLength(2);
      expect(tablero.days[0].label).toContain('domingo 30 de agosto');
    });
  });

  describe('historial de movimientos', () => {
    it('conserva la baja de alguien que después fue reemplazado', async () => {
      const { shift, gente } = await escenario(3);
      const asignacion = await ctx.prisma.assignment.findFirstOrThrow({
        where: { shiftId: shift.id, participantId: gente[0].id },
      });

      await assignments.cancel({
        assignmentId: asignacion.id,
        ...admin('Elena Mora'),
        reasonCode: 'enfermedad',
      });
      await assignments.assignManually({
        shiftId: shift.id,
        participantId: gente[3].id,
        ...admin('Felipe Cruz'),
      });

      const historial = await reports.shiftHistory(shift.id);

      const baja = historial.find((m) => m.action === 'assignment.cancelled');
      const alta = historial.find((m) => m.action === 'assignment.created');

      expect(baja?.description).toContain('Ana López');
      expect(baja?.description).toContain('canceló');
      expect(baja?.by).toBe('Elena Mora');
      expect(alta?.description).toContain('Dora Sosa');
      expect(alta?.by).toBe('Felipe Cruz');
      // Orden cronológico: primero la baja, después la cobertura.
      expect(historial.indexOf(baja!)).toBeLessThan(historial.indexOf(alta!));
    });

    it('lista la actividad reciente del punto, de la más nueva a la más vieja', async () => {
      const { location, shift, gente } = await escenario(3);
      const asignacion = await ctx.prisma.assignment.findFirstOrThrow({
        where: { shiftId: shift.id, participantId: gente[0].id },
      });

      await assignments.cancel({ assignmentId: asignacion.id, ...admin(), reasonCode: 'trabajo' });
      ctx.time.setClock(() => new Date(NOW.getTime() + 60_000));
      await assignments.assignManually({
        shiftId: shift.id,
        participantId: gente[3].id,
        ...admin(),
      });

      const movimientos = await reports.recentMovements(location.id, 10);

      expect(movimientos.length).toBeGreaterThanOrEqual(2);
      expect(movimientos[0].action).toBe('assignment.created');
      expect(movimientos[1].action).toBe('assignment.cancelled');
    });
  });

  describe('texto para la encuesta', () => {
    it('lista los turnos que necesitan gente, con cuántos faltan', async () => {
      const { location, shift, gente } = await escenario(3);
      const asignacion = await ctx.prisma.assignment.findFirstOrThrow({
        where: { shiftId: shift.id, participantId: gente[0].id },
      });
      await assignments.cancel({ assignmentId: asignacion.id, ...admin(), reasonCode: 'otro' });

      const borrador = await poll.build(location.id, RANGO_INICIO, RANGO_FIN);

      expect(borrador.options).toHaveLength(1);
      expect(borrador.options[0].text).toBe('Dom. 30 de *07:00 a 09:00 am* (Un(a) Participante)');
      expect(borrador.question).toContain('¿Quién puede apoyar en el exhibidor');
      expect(borrador.truncated).toBe(false);
    });

    it('marca am y pm en los dos extremos solo cuando el turno cruza el mediodía', async () => {
      const location = await createLocation(ctx.prisma, { minCapacity: 2, defaultCapacity: 3 });
      await createShift(ctx.prisma, location.id, {
        startsAt: new Date('2026-08-30T17:00:00.000Z'),
        startMinute: 11 * 60,
        endMinute: 13 * 60,
        capacity: 2,
      });

      const borrador = await poll.build(location.id, RANGO_INICIO, RANGO_FIN);

      expect(borrador.options[0].text).toBe('Dom. 30 de *11:00 am a 01:00 pm* (Dos Participantes)');
    });

    it('con nivel «mínimo» solo convoca lo que está por debajo de dos personas', async () => {
      const { location, shift, gente } = await escenario(3);
      const primera = await ctx.prisma.assignment.findFirstOrThrow({
        where: { shiftId: shift.id, participantId: gente[0].id },
      });
      await assignments.cancel({ assignmentId: primera.id, ...admin(), reasonCode: 'otro' });

      // Con dos personas, el turno opera: no entra en la convocatoria mínima.
      expect(
        (await poll.build(location.id, RANGO_INICIO, RANGO_FIN, 'minimo')).options,
      ).toHaveLength(0);
      expect((await poll.build(location.id, RANGO_INICIO, RANGO_FIN, 'cupo')).options).toHaveLength(
        1,
      );

      const segunda = await ctx.prisma.assignment.findFirstOrThrow({
        where: { shiftId: shift.id, participantId: gente[1].id },
      });
      await assignments.cancel({ assignmentId: segunda.id, ...admin(), reasonCode: 'otro' });

      const critico = await poll.build(location.id, RANGO_INICIO, RANGO_FIN, 'minimo');
      expect(critico.options).toHaveLength(1);
      expect(critico.options[0].text).toContain('Un(a) Participante');
    });

    it('corta en doce opciones y lo advierte, porque es el límite de WhatsApp', async () => {
      const location = await createLocation(ctx.prisma);
      // Quince turnos vacíos en días consecutivos.
      for (let i = 0; i < 15; i += 1) {
        await createShift(ctx.prisma, location.id, {
          startsAt: new Date(Date.UTC(2026, 7, 26 + i, 13, 0, 0)),
          capacity: 3,
        });
      }

      const borrador = await poll.build(
        location.id,
        new Date('2026-08-26T00:00:00.000Z'),
        new Date('2026-09-20T23:59:59.000Z'),
      );

      expect(borrador.totalNeeded).toBe(15);
      expect(borrador.options).toHaveLength(12);
      expect(borrador.truncated).toBe(true);
      expect(borrador.maxOptions).toBe(12);
    });

    it('respeta el rango de fechas elegido', async () => {
      const location = await createLocation(ctx.prisma);
      await createShift(ctx.prisma, location.id, {
        startsAt: new Date('2026-08-30T13:00:00.000Z'),
      });
      await createShift(ctx.prisma, location.id, {
        startsAt: new Date('2026-09-20T13:00:00.000Z'),
      });

      const borrador = await poll.build(
        location.id,
        new Date('2026-08-29T00:00:00.000Z'),
        new Date('2026-08-31T23:59:59.000Z'),
      );

      expect(borrador.options).toHaveLength(1);
      expect(borrador.options[0].date).toBe('2026-08-30');
    });

    it('lo dice con claridad cuando no hace falta cubrir nada', async () => {
      const { location } = await escenario(3);
      const borrador = await poll.build(location.id, RANGO_INICIO, RANGO_FIN);

      expect(borrador.options).toHaveLength(0);
      expect(borrador.plainText).toContain('no hay turnos por cubrir');
    });
  });
});
