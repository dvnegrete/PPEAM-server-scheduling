import { AssignmentStatus } from '@prisma/client';
import { createLocation, createParticipant, createShift } from '../../test/helpers/fixtures';
import { createFullTestContext, resetDatabase, TestContext } from '../../test/helpers/test-context';
import { ReportsService } from './reports.service';

/**
 * Noviembre de 2026 empieza en domingo: el primer domingo (1) cae antes que el
 * primer sábado (7), y el domingo 8 ya es el segundo domingo.
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

  it('pone un bloque por día entre semana con los titulares, aunque uno cancele una fecha', async () => {
    const { location } = await escenario();
    const rol = await reports.monthRoster(location.id, 2026, 11);

    expect(rol.weekdays.map((dia) => dia.title)).toEqual(['Lunes']);
    const turno = rol.weekdays[0].slots[0];
    expect(turno.range).toBe('07:00 a 09:00 am');
    expect(turno.people.map((p) => p.name)).toEqual(['Ana López', 'Beto Ruiz', 'Carla Díaz']);
    expect(turno.people[0].phone).toMatch(/^55 \d{4} \d{4}$/);
  });

  it('ordena los fines de semana por ordinal, el sábado antes que el domingo', async () => {
    const { location } = await escenario();
    const rol = await reports.monthRoster(location.id, 2026, 11);

    expect(rol.weekends.map((dia) => [dia.title, dia.subtitle])).toEqual([
      ['Primer sábado', '7 de noviembre de 2026'],
      ['Primer domingo', '1 de noviembre de 2026'],
      ['Segundo domingo', '8 de noviembre de 2026'],
    ]);
  });

  it('deja fuera del fin de semana a quien canceló', async () => {
    const { location } = await escenario();
    const rol = await reports.monthRoster(location.id, 2026, 11);

    const sabado = rol.weekends[0].slots[0];
    expect(sabado.people.map((p) => p.name)).toEqual(['Ana López']);
    expect(sabado.missing).toBe(2);
  });
});
