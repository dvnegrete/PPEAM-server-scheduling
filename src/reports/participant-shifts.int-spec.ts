import { AssignmentOrigin, AssignmentStatus } from '@prisma/client';
import { createLocation, createParticipant, createShift } from '../../test/helpers/fixtures';
import { createFullTestContext, resetDatabase, TestContext } from '../../test/helpers/test-context';
import { ReportsService } from './reports.service';

/** Martes 10 de noviembre de 2026, mediodía en el centro de México. */
const NOW = new Date('2026-11-10T18:00:00.000Z');

/** Las 7:00 en el centro de México (UTC-6) del día indicado de noviembre. */
const sieteAm = (dia: number) => new Date(`2026-11-${String(dia).padStart(2, '0')}T13:00:00.000Z`);

describe('Turnos de un participante (integración)', () => {
  let ctx: TestContext;
  let reports: ReportsService;

  beforeAll(async () => {
    ctx = await createFullTestContext();
    reports = ctx.module.get(ReportsService);
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    ctx.time.setClock(() => NOW);
  });

  async function escenario() {
    const location = await createLocation(ctx.prisma);
    const [ana, beto, carla] = await Promise.all(
      ['Ana López', 'Beto Ruiz', 'Carla Díaz'].map((nombre) =>
        createParticipant(ctx.prisma, location.id, nombre),
      ),
    );

    // Ana es titular y capitana de los lunes de 7 a 9, todas las semanas.
    const plantilla = await ctx.prisma.shiftTemplate.create({
      data: { locationId: location.id, weekday: 1, startMinute: 420, endMinute: 540 },
    });
    await ctx.prisma.recurringAssignment.create({
      data: { shiftTemplateId: plantilla.id, participantId: ana.id, isCaptain: true },
    });

    // El lunes 9 ya pasó; el 16 y el 23 están por venir.
    const lunes = [];
    for (const dia of [9, 16, 23]) {
      const turno = await createShift(ctx.prisma, location.id, {
        startsAt: sieteAm(dia),
        participantIds: [ana.id, beto.id],
      });
      await ctx.prisma.shift.update({
        where: { id: turno.id },
        data: { templateId: plantilla.id },
      });
      lunes.push(turno);
    }

    // Ana ya avisó que el lunes 23 no va.
    await ctx.prisma.assignment.update({
      where: { shiftId_participantId: { shiftId: lunes[2].id, participantId: ana.id } },
      data: { status: AssignmentStatus.CANCELLED, cancelledAt: NOW, cancelReason: 'Viaje' },
    });

    // Y entró a cubrir el sábado 14, que no es turno suyo.
    const sabado = await createShift(ctx.prisma, location.id, {
      startsAt: sieteAm(14),
      participantIds: [carla.id],
    });
    await ctx.prisma.assignment.create({
      data: {
        shiftId: sabado.id,
        participantId: ana.id,
        origin: AssignmentOrigin.COVERAGE,
        status: AssignmentStatus.ASSIGNED,
      },
    });

    return { location, ana, beto };
  }

  it('lista los turnos fijos con su día, horario y capitanía', async () => {
    const { location, ana } = await escenario();
    const turnos = await reports.participantShifts(location.id, ana.id);

    expect(turnos.participant.name).toBe('Ana López');
    expect(turnos.participant.phone).toMatch(/^55 \d{4} \d{4}$/);
    expect(turnos.fixed).toEqual([
      { label: 'Lunes · cada semana', range: '7 a 9 am', isCaptain: true },
    ]);
  });

  it('muestra las fechas por venir, con la sustitución, y deja fuera lo que ya pasó', async () => {
    const { location, ana } = await escenario();
    const { upcoming } = await reports.participantShifts(location.id, ana.id);

    expect(upcoming.map((turno) => [turno.date, turno.origin, turno.cancelled])).toEqual([
      ['2026-11-14', AssignmentOrigin.COVERAGE, false],
      ['2026-11-16', AssignmentOrigin.FIXED, false],
      ['2026-11-23', AssignmentOrigin.FIXED, true],
    ]);
    expect(upcoming[0].companions).toEqual(['Carla Díaz']);
    expect(upcoming[1].companions).toEqual(['Beto Ruiz']);
    expect(upcoming[1].isCaptain).toBe(true);
  });

  it('marca la baja con su motivo y sin capitanía', async () => {
    const { location, ana } = await escenario();
    const { upcoming } = await reports.participantShifts(location.id, ana.id);

    expect(upcoming[2]).toMatchObject({
      cancelled: true,
      cancelReason: 'Viaje',
      isCaptain: false,
    });
  });

  it('a quien no tiene turnos le devuelve las dos listas vacías', async () => {
    const { location } = await escenario();
    const dora = await createParticipant(ctx.prisma, location.id, 'Dora Sosa');
    const turnos = await reports.participantShifts(location.id, dora.id);

    expect(turnos.fixed).toEqual([]);
    expect(turnos.upcoming).toEqual([]);
  });
});
