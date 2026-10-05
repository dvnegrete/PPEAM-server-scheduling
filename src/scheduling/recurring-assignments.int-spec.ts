import { ParticipantStatus } from '@prisma/client';
import { createLocation, createParticipant } from '../../test/helpers/fixtures';
import { createTestContext, resetDatabase, TestContext } from '../../test/helpers/test-context';
import { RecurringAssignmentsService } from './recurring-assignments.service';
import { ScheduleGeneratorService } from './schedule-generator.service';

/** Reloj fijo: martes 25 de agosto de 2026, 12:00 hora del centro de México. */
const NOW = new Date('2026-08-25T18:00:00.000Z');

describe('Turnos fijos (integración)', () => {
  let ctx: TestContext;
  let recurring: RecurringAssignmentsService;
  let generator: ScheduleGeneratorService;

  beforeAll(async () => {
    ctx = await createTestContext();
    recurring = ctx.module.get(RecurringAssignmentsService);
    generator = ctx.module.get(ScheduleGeneratorService);
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    ctx.time.setClock(() => NOW);
  });

  /** Una franja de miércoles de 7 a 9, todas las semanas. */
  async function crearFranja(locationId: string, capacity = 2, weekOfMonth = 0) {
    return ctx.prisma.shiftTemplate.create({
      data: {
        locationId,
        weekday: 3,
        startMinute: 7 * 60,
        endMinute: 9 * 60,
        capacity,
        weekOfMonth,
      },
    });
  }

  it('lista las franjas del punto con sus titulares y los lugares libres', async () => {
    const location = await createLocation(ctx.prisma);
    const plantilla = await crearFranja(location.id, 3);
    const ana = await createParticipant(ctx.prisma, location.id, 'Ana López Pérez');

    await recurring.assign(plantilla.id, ana.id, { id: 'admin-1', name: 'Elena' });

    const franjas = await recurring.listByLocation(location.id);
    expect(franjas).toHaveLength(1);
    expect(franjas[0]).toMatchObject({
      templateId: plantilla.id,
      weekday: 3,
      weekOfMonth: 0,
      range: '7:00 a 9:00',
      capacity: 3,
      freeSlots: 2,
    });
    expect(franjas[0].holders.map((titular) => titular.name)).toEqual(['Ana López']);
  });

  it('no sienta más titulares que lugares', async () => {
    const location = await createLocation(ctx.prisma);
    const plantilla = await crearFranja(location.id, 1);
    const ana = await createParticipant(ctx.prisma, location.id, 'Ana López Pérez');
    const luis = await createParticipant(ctx.prisma, location.id, 'Luis Mora Ruiz');

    await recurring.assign(plantilla.id, ana.id);

    // Sentar a dos titulares en un solo lugar dejaría la franja llena para
    // siempre, sin espacio para que nadie cubra una baja.
    await expect(recurring.assign(plantilla.id, luis.id)).rejects.toThrow(
      /1 titulares para 1 lugares/,
    );

    const [franja] = await recurring.listByLocation(location.id);
    expect(franja.holders).toHaveLength(1);
  });

  it('rechaza a quien ya es titular de la misma franja', async () => {
    const location = await createLocation(ctx.prisma);
    const plantilla = await crearFranja(location.id);
    const ana = await createParticipant(ctx.prisma, location.id, 'Ana López Pérez');

    await recurring.assign(plantilla.id, ana.id);
    await expect(recurring.assign(plantilla.id, ana.id)).rejects.toThrow(/ya es titular/);
  });

  it('rechaza a quien no está activo en el padrón', async () => {
    const location = await createLocation(ctx.prisma);
    const plantilla = await crearFranja(location.id);
    const ana = await createParticipant(ctx.prisma, location.id, 'Ana López Pérez');
    await ctx.prisma.participant.update({
      where: { id: ana.id },
      data: { status: ParticipantStatus.PAUSED },
    });

    await expect(recurring.assign(plantilla.id, ana.id)).rejects.toThrow(/no está activo/);
  });

  it('reutiliza la asignación anterior al volver a sentar a alguien', async () => {
    const location = await createLocation(ctx.prisma);
    const plantilla = await crearFranja(location.id);
    const ana = await createParticipant(ctx.prisma, location.id, 'Ana López Pérez');

    await recurring.assign(plantilla.id, ana.id);
    const [primera] = await recurring.listByLocation(location.id);
    await recurring.unassign(primera.holders[0].recurringId);
    await recurring.assign(plantilla.id, ana.id);

    // El índice único no deja dos filas para la misma pareja: la de antes se
    // reactiva en lugar de duplicarse.
    const filas = await ctx.prisma.recurringAssignment.findMany({
      where: { shiftTemplateId: plantilla.id, participantId: ana.id },
    });
    expect(filas).toHaveLength(1);
    expect(filas[0].active).toBe(true);
  });

  it('quitar un turno fijo no toca los turnos ya generados', async () => {
    const location = await createLocation(ctx.prisma);
    const plantilla = await crearFranja(location.id);
    const ana = await createParticipant(ctx.prisma, location.id, 'Ana López Pérez');

    await recurring.assign(plantilla.id, ana.id);
    await generator.generateMonth(location.id, 2026, 9);

    const antes = await ctx.prisma.assignment.count({ where: { participantId: ana.id } });
    expect(antes).toBeGreaterThan(0);

    const [franja] = await recurring.listByLocation(location.id);
    await recurring.unassign(franja.holders[0].recurringId, { id: 'admin-1', name: 'Elena' });

    // Lo que ya está en el calendario sigue en pie: quitar el turno fijo cambia
    // lo que se materialice de ahora en adelante, no lo que ya se publicó.
    const despues = await ctx.prisma.assignment.count({ where: { participantId: ana.id } });
    expect(despues).toBe(antes);
  });

  it('el calendario nuevo nace con los titulares sentados', async () => {
    const location = await createLocation(ctx.prisma);
    const plantilla = await crearFranja(location.id);
    const ana = await createParticipant(ctx.prisma, location.id, 'Ana López Pérez');
    await recurring.assign(plantilla.id, ana.id);

    await generator.generateMonth(location.id, 2026, 9);

    // Septiembre de 2026 tiene cinco miércoles.
    const turnos = await ctx.prisma.shift.findMany({
      where: { locationId: location.id },
      include: { assignments: true },
    });
    expect(turnos).toHaveLength(5);
    for (const turno of turnos) {
      expect(turno.assignments.map((asignacion) => asignacion.participantId)).toEqual([ana.id]);
    }
  });

  it('los candidatos excluyen a los titulares y a quien no es del punto', async () => {
    const location = await createLocation(ctx.prisma);
    const otro = await createLocation(ctx.prisma);
    const plantilla = await crearFranja(location.id);
    const ana = await createParticipant(ctx.prisma, location.id, 'Ana López Pérez');
    const luis = await createParticipant(ctx.prisma, location.id, 'Luis Mora Ruiz');
    const ajena = await createParticipant(ctx.prisma, otro.id, 'Sara Vega Díaz');

    await recurring.assign(plantilla.id, ana.id);

    const candidatos = await recurring.candidatesFor(plantilla.id, location.id);
    const ids = candidatos.map((persona) => persona.id);
    expect(ids).toContain(luis.id);
    expect(ids).not.toContain(ana.id);
    expect(ids).not.toContain(ajena.id);
  });

  it('alguien puede ser titular de dos franjas distintas', async () => {
    const location = await createLocation(ctx.prisma);
    const manana = await crearFranja(location.id);
    const tarde = await ctx.prisma.shiftTemplate.create({
      data: {
        locationId: location.id,
        weekday: 3,
        startMinute: 15 * 60,
        endMinute: 17 * 60,
        capacity: 2,
        weekOfMonth: 0,
      },
    });
    const ana = await createParticipant(ctx.prisma, location.id, 'Ana López Pérez');

    await recurring.assign(manana.id, ana.id);
    await recurring.assign(tarde.id, ana.id);

    const conteo = await recurring.countByParticipant(location.id);
    expect(conteo.get(ana.id)).toBe(2);
  });

  it('deja rastro de quién sentó y quién quitó a cada titular', async () => {
    const location = await createLocation(ctx.prisma);
    const plantilla = await crearFranja(location.id);
    const ana = await createParticipant(ctx.prisma, location.id, 'Ana López Pérez');

    await recurring.assign(plantilla.id, ana.id, { id: 'admin-1', name: 'Elena Mora' });
    const [franja] = await recurring.listByLocation(location.id);
    await recurring.unassign(franja.holders[0].recurringId, { id: 'admin-1', name: 'Elena Mora' });

    const registros = await ctx.prisma.auditLog.findMany({
      where: { entity: 'RecurringAssignment' },
      orderBy: { createdAt: 'asc' },
    });
    expect(registros.map((registro) => registro.action)).toEqual([
      'recurring.assigned',
      'recurring.unassigned',
    ]);
    expect(registros.every((registro) => registro.actorName === 'Elena Mora')).toBe(true);
  });
});
