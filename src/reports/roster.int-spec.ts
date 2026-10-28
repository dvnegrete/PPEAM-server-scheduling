import { AssignmentStatus } from '@prisma/client';
import { createLocation, createParticipant, createShift } from '../../test/helpers/fixtures';
import { createFullTestContext, resetDatabase, TestContext } from '../../test/helpers/test-context';
import { ReportsService } from './reports.service';

/**
 * Noviembre de 2026 empieza en domingo: el domingo 1 queda como un fin de semana
 * suelto y luego vienen sábado 7 y domingo 8 juntos.
 */
const NOW = new Date('2026-10-27T18:00:00.000Z');

/** Las 7:00 en el centro de México (UTC-6) del día indicado de noviembre. */
const sieteAm = (dia: number) => new Date(`2026-11-${String(dia).padStart(2, '0')}T13:00:00.000Z`);

describe('Rol del mes (integración)', () => {
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
    const [ana, beto, carla, dora] = await Promise.all(
      ['Ana López', 'Beto Ruiz', 'Carla Díaz', 'Dora Sosa'].map((nombre) =>
        createParticipant(ctx.prisma, location.id, nombre),
      ),
    );

    // Todos los lunes de noviembre, de 7 a 9, con los mismos tres titulares.
    const lunes = [];
    for (const dia of [2, 9, 16, 23, 30]) {
      lunes.push(
        await createShift(ctx.prisma, location.id, {
          startsAt: sieteAm(dia),
          participantIds: [ana.id, beto.id, carla.id],
        }),
      );
    }

    // Beto avisó que el lunes 9 no va.
    await ctx.prisma.assignment.update({
      where: { shiftId_participantId: { shiftId: lunes[1].id, participantId: beto.id } },
      data: { status: AssignmentStatus.CANCELLED, cancelledAt: NOW },
    });

    await createShift(ctx.prisma, location.id, {
      startsAt: sieteAm(1),
      participantIds: [dora.id],
    });
    const sabado7 = await createShift(ctx.prisma, location.id, {
      startsAt: sieteAm(7),
      participantIds: [ana.id, dora.id],
    });
    await createShift(ctx.prisma, location.id, {
      startsAt: sieteAm(8),
      participantIds: [beto.id, carla.id, dora.id],
    });

    // Dora canceló el sábado 7.
    await ctx.prisma.assignment.update({
      where: { shiftId_participantId: { shiftId: sabado7.id, participantId: dora.id } },
      data: { status: AssignmentStatus.CANCELLED, cancelledAt: NOW },
    });

    return { location };
  }

  it('resume entre semana con los titulares, aunque uno haya cancelado una fecha', async () => {
    const { location } = await escenario();
    const rol = await reports.monthRoster(location.id, 2026, 11);

    expect(rol.weekdays).toHaveLength(1);
    expect(rol.weekdays[0].days[1].people.map((p) => p.name)).toEqual([
      'Ana López',
      'Beto Ruiz',
      'Carla Díaz',
    ]);
    expect(rol.weekdays[0].days[1].people[0].phone).toMatch(/^55 \d{4} \d{4}$/);
  });

  it('lista solo la fecha que cambió, con quién sí asiste', async () => {
    const { location } = await escenario();
    const rol = await reports.monthRoster(location.id, 2026, 11);

    expect(rol.weekdayChanges).toHaveLength(1);
    expect(rol.weekdayChanges[0]).toMatchObject({ date: '2026-11-09', missing: 1 });
    expect(rol.weekdayChanges[0].attendees.map((p) => p.name)).toEqual(['Ana López', 'Carla Díaz']);
  });

  it('agrupa los fines de semana y deja fuera a quien canceló', async () => {
    const { location } = await escenario();
    const rol = await reports.monthRoster(location.id, 2026, 11);

    expect(rol.weekends.map((w) => w.days.map((d) => d.date))).toEqual([
      ['2026-11-01'],
      ['2026-11-07', '2026-11-08'],
    ]);
    const sabado = rol.weekends[1].days[0];
    expect(sabado.slots[0].people.map((p) => p.name)).toEqual(['Ana López']);
    expect(sabado.slots[0].missing).toBe(2);
  });
});
