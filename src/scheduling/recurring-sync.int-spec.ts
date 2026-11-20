import { AssignmentStatus } from '@prisma/client';
import { createLocation, createParticipant } from '../../test/helpers/fixtures';
import { createFullTestContext, resetDatabase, TestContext } from '../../test/helpers/test-context';
import { MonthRosterService } from '../reports/month-roster.service';
import { AssignmentsService } from './assignments.service';
import { RecurringAssignmentsService } from './recurring-assignments.service';
import { RecurringSyncService } from './recurring-sync.service';
import { ScheduleGeneratorService } from './schedule-generator.service';

/**
 * Reloj fijo: martes 25 de agosto de 2026. Septiembre es el mes próximo; empieza
 * en martes, así que el primer sábado es el 5 y los miércoles son 2, 9, 16, 23 y 30.
 */
const NOW = new Date('2026-08-25T18:00:00.000Z');

describe('Turnos fijos aplicados a los meses próximos (integración)', () => {
  let ctx: TestContext;
  let recurring: RecurringAssignmentsService;
  let sync: RecurringSyncService;
  let generator: ScheduleGeneratorService;
  let assignments: AssignmentsService;
  let roster: MonthRosterService;

  beforeAll(async () => {
    ctx = await createFullTestContext();
    recurring = ctx.module.get(RecurringAssignmentsService);
    sync = ctx.module.get(RecurringSyncService);
    generator = ctx.module.get(ScheduleGeneratorService);
    assignments = ctx.module.get(AssignmentsService);
    roster = ctx.module.get(MonthRosterService);
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    ctx.time.setClock(() => NOW);
  });

  /** Miércoles de 7 a 9 todas las semanas, y el primer sábado de 7 a 9. */
  async function escenario() {
    const location = await createLocation(ctx.prisma);
    const miercoles = await ctx.prisma.shiftTemplate.create({
      data: {
        locationId: location.id,
        weekday: 3,
        startMinute: 7 * 60,
        endMinute: 9 * 60,
        capacity: 2,
        weekOfMonth: 0,
      },
    });
    const primerSabado = await ctx.prisma.shiftTemplate.create({
      data: {
        locationId: location.id,
        weekday: 6,
        startMinute: 7 * 60,
        endMinute: 9 * 60,
        capacity: 2,
        weekOfMonth: 1,
      },
    });
    const [ana, beto, carla] = await Promise.all(
      ['Ana López', 'Beto Ruiz', 'Carla Díaz'].map((nombre) =>
        createParticipant(ctx.prisma, location.id, nombre),
      ),
    );
    for (const plantilla of [miercoles, primerSabado]) {
      await recurring.assign(plantilla.id, ana.id);
      await recurring.assign(plantilla.id, beto.id);
    }
    return { location, miercoles, primerSabado, ana, beto, carla };
  }

  /** Cambia a Ana por Carla en las dos franjas, como se haría desde el panel. */
  async function cambiarAnaPorCarla(
    locationId: string,
    anaId: string,
    carlaId: string,
    plantillas: string[],
  ) {
    const franjas = await recurring.listByLocation(locationId);
    for (const franja of franjas) {
      const deAna = franja.holders.find((holder) => holder.participantId === anaId);
      if (deAna) await recurring.unassign(deAna.recurringId);
    }
    for (const plantilla of plantillas) await recurring.assign(plantilla, carlaId);
  }

  it('no hay nada pendiente si los meses próximos ya reflejan los turnos fijos', async () => {
    const { location } = await escenario();
    await generator.generateMonth(location.id, 2026, 9);

    expect(await sync.pendingChanges(location.id)).toEqual([]);
  });

  it('detecta el mes próximo ya generado que no refleja un cambio de titular', async () => {
    const { location, miercoles, primerSabado, ana, carla } = await escenario();
    await generator.generateMonth(location.id, 2026, 9);

    await cambiarAnaPorCarla(location.id, ana.id, carla.id, [miercoles.id, primerSabado.id]);

    expect(await sync.pendingChanges(location.id)).toEqual([
      {
        year: 2026,
        month: 9,
        label: 'septiembre 2026',
        toRelease: 6,
        toSeat: 6,
        notSeated: 0,
        shiftsToCreate: 0,
      },
    ]);
  });

  it('no lista el mes en curso ni los meses que no se han generado', async () => {
    const { location, miercoles, primerSabado, ana, carla } = await escenario();
    await generator.generateMonth(location.id, 2026, 8);

    await cambiarAnaPorCarla(location.id, ana.id, carla.id, [miercoles.id, primerSabado.id]);

    expect(await sync.pendingChanges(location.id)).toEqual([]);
    expect(await sync.upcomingGeneratedMonths(location.id)).toEqual([]);
  });

  it('cambiar solo el capitán no deja nada pendiente', async () => {
    const { location } = await escenario();
    await generator.generateMonth(location.id, 2026, 9);

    const [franja] = await recurring.listByLocation(location.id);
    await recurring.setCaptain(franja.holders[0].recurringId, true);

    expect(await sync.pendingChanges(location.id)).toEqual([]);
  });

  it('aplica a todos los meses próximos generados, sin crear meses nuevos', async () => {
    const { location, miercoles, primerSabado, ana, carla } = await escenario();
    await generator.generateMonth(location.id, 2026, 9);
    await generator.generateMonth(location.id, 2026, 10);
    await cambiarAnaPorCarla(location.id, ana.id, carla.id, [miercoles.id, primerSabado.id]);

    const aplicados = await sync.applyToUpcomingMonths(location.id, {
      id: 'admin-1',
      name: 'Elena Mora',
    });

    expect(aplicados.map((mes) => mes.label)).toEqual(['septiembre 2026', 'octubre 2026']);
    expect(aplicados.every((mes) => mes.result.shiftsCreated === 0)).toBe(true);
    expect(
      await ctx.prisma.shift.count({
        where: { locationId: location.id, date: { gte: new Date('2026-11-01') } },
      }),
    ).toBe(0);
    expect(await sync.pendingChanges(location.id)).toEqual([]);
  });

  it('el rol del mes muestra al nuevo titular y conserva la cancelación previa', async () => {
    const { location, miercoles, primerSabado, ana, beto, carla } = await escenario();
    await generator.generateMonth(location.id, 2026, 9);

    // Beto avisó que el primer sábado no va.
    const sabado = await ctx.prisma.shift.findFirstOrThrow({
      where: { locationId: location.id, date: new Date('2026-09-05') },
    });
    const deBeto = await ctx.prisma.assignment.findFirstOrThrow({
      where: { shiftId: sabado.id, participantId: beto.id },
    });
    await assignments.cancel({ assignmentId: deBeto.id, notify: false });

    await cambiarAnaPorCarla(location.id, ana.id, carla.id, [miercoles.id, primerSabado.id]);
    await sync.applyToUpcomingMonths(location.id);

    const rol = await roster.monthRoster(location.id, 2026, 9);

    const miercolesDelRol = rol.weekdays.find((dia) => dia.title === 'Miércoles');
    expect(miercolesDelRol?.slots[0].people.map((p) => p.name).sort()).toEqual([
      'Beto Ruiz',
      'Carla Díaz',
    ]);

    expect(rol.weekends).toHaveLength(1);
    expect(rol.weekends[0].slots[0].people.map((p) => p.name)).toEqual(['Carla Díaz']);
    expect(rol.weekends[0].slots[0].missing).toBe(1);

    const cancelacion = await ctx.prisma.assignment.findUniqueOrThrow({ where: { id: deBeto.id } });
    expect(cancelacion.status).toBe(AssignmentStatus.CANCELLED);
  });
});
