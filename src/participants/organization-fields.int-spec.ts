import { createLocation, createParticipant } from '../../test/helpers/fixtures';
import { createFullTestContext, resetDatabase, TestContext } from '../../test/helpers/test-context';
import { OrganizationFieldsService } from './organization-fields.service';
import { ParticipantsService } from './participants.service';

describe('Congregación, circuito y ciudad (integración)', () => {
  let ctx: TestContext;
  let participantes: ParticipantsService;
  let organizacion: OrganizationFieldsService;
  let locationId: string;

  beforeAll(async () => {
    ctx = await createFullTestContext();
    participantes = ctx.module.get(ParticipantsService);
    organizacion = ctx.module.get(OrganizationFieldsService);
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    const location = await createLocation(ctx.prisma);
    locationId = location.id;
  });

  const admin = { id: 'admin-1', name: 'David Negrete' };

  it('el padrón importado nace sin estos datos', async () => {
    const ana = await createParticipant(ctx.prisma, locationId, 'Ana López');
    expect(ana.congregation).toBeNull();
    expect(ana.circuit).toBeNull();
    expect(ana.city).toBeNull();
  });

  it('guarda los tres campos al dar de alta', async () => {
    const creada = await participantes.create({
      firstName: 'Ana María',
      paternalSurname: 'López',
      maternalSurname: 'Pérez',
      phone: '5512345678',
      locationId,
      congregation: 'Centro',
      circuit: 'Monterrey 14',
      city: 'Monterrey',
    });

    expect(creada.congregation).toBe('Centro');
    expect(creada.circuit).toBe('Monterrey 14');
    expect(creada.city).toBe('Monterrey');
  });

  describe('normalización, para que los filtros no se partan', () => {
    it('alinea una grafía equivalente con la ya registrada', async () => {
      const primera = await createParticipant(ctx.prisma, locationId, 'Ana López');
      await participantes.updateOrganization(primera.id, { congregation: 'Valle Verde' }, admin);

      const segunda = await createParticipant(ctx.prisma, locationId, 'Beto Ruiz');
      // Se captura con otra grafía: minúsculas, acento ausente y espacio de más.
      await participantes.updateOrganization(
        segunda.id,
        { congregation: '  valle  verde ' },
        admin,
      );

      const guardadas = await ctx.prisma.participant.findMany({
        select: { congregation: true },
      });
      // Las dos quedan con la misma grafía: un solo valor en el filtro.
      expect(new Set(guardadas.map((p) => p.congregation))).toEqual(new Set(['Valle Verde']));
    });

    it('iguala también ignorando acentos', async () => {
      const primera = await createParticipant(ctx.prisma, locationId, 'Ana López');
      await participantes.updateOrganization(primera.id, { city: 'Querétaro' }, admin);

      const segunda = await createParticipant(ctx.prisma, locationId, 'Beto Ruiz');
      await participantes.updateOrganization(segunda.id, { city: 'queretaro' }, admin);

      const valores = await organizacion.knownValues('city');
      expect(valores).toEqual(['Querétaro']);
    });

    it('conserva un valor nuevo tal como se escribió', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López');
      await participantes.updateOrganization(ana.id, { congregation: 'San José' }, admin);

      const guardada = await ctx.prisma.participant.findUniqueOrThrow({ where: { id: ana.id } });
      expect(guardada.congregation).toBe('San José');
    });

    it('un valor vacío se guarda como sin dato, no como cadena en blanco', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López');
      await participantes.updateOrganization(ana.id, { congregation: '   ' }, admin);

      const guardada = await ctx.prisma.participant.findUniqueOrThrow({ where: { id: ana.id } });
      expect(guardada.congregation).toBeNull();
    });
  });

  describe('valores conocidos, para sugerir y filtrar', () => {
    it('devuelve los distintos valores en orden alfabético', async () => {
      for (const [nombre, congregacion] of [
        ['Ana López', 'Zapata'],
        ['Beto Ruiz', 'Centro'],
        ['Carla Díaz', 'Morelos'],
        ['Dora Sosa', 'Centro'],
      ] as const) {
        const persona = await createParticipant(ctx.prisma, locationId, nombre);
        await participantes.updateOrganization(persona.id, { congregation: congregacion }, admin);
      }

      expect(await organizacion.knownValues('congregation')).toEqual([
        'Centro',
        'Morelos',
        'Zapata',
      ]);
    });

    it('no incluye a quienes no tienen el dato', async () => {
      await createParticipant(ctx.prisma, locationId, 'Ana López');
      expect(await organizacion.knownValues('congregation')).toEqual([]);
    });
  });

  describe('reporte por campo', () => {
    it('cuenta la gente de cada valor y deja al final a los que falta completar', async () => {
      for (const [nombre, congregacion] of [
        ['Ana López', 'Centro'],
        ['Beto Ruiz', 'Centro'],
        ['Carla Díaz', 'Morelos'],
      ] as const) {
        const persona = await createParticipant(ctx.prisma, locationId, nombre);
        await participantes.updateOrganization(persona.id, { congregation: congregacion }, admin);
      }
      // Sin congregación capturada.
      await createParticipant(ctx.prisma, locationId, 'Dora Sosa');

      const reporte = await organizacion.countByField('congregation', locationId);

      expect(reporte).toEqual([
        { value: 'Centro', count: 2 },
        { value: 'Morelos', count: 1 },
        { value: null, count: 1 },
      ]);
    });
  });

  it('deja registro en bitácora de quién capturó el dato', async () => {
    const ana = await createParticipant(ctx.prisma, locationId, 'Ana López');
    await participantes.updateOrganization(
      ana.id,
      { congregation: 'Centro', circuit: 'Monterrey 14', city: 'Monterrey' },
      admin,
    );

    const registro = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'participant.updated' },
    });
    expect(registro.actorName).toBe('David Negrete');
    expect((registro.after as { congregation: string }).congregation).toBe('Centro');
  });
});
