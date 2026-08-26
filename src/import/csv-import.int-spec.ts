import { createLocation, createParticipant } from '../../test/helpers/fixtures';
import { createTestContext, resetDatabase, TestContext } from '../../test/helpers/test-context';
import { CsvImportService } from './csv-import.service';
import { ImportModule } from './import.module';

describe('Importación desde CSV (integración)', () => {
  let ctx: TestContext;
  let importer: CsvImportService;
  let locationId: string;

  beforeAll(async () => {
    ctx = await createTestContext([ImportModule]);
    importer = ctx.module.get(CsvImportService);
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    const location = await createLocation(ctx.prisma);
    locationId = location.id;
  });

  /** Turno de lunes 7:00, todas las semanas. */
  async function plantillaLunes(capacity = 3) {
    return ctx.prisma.shiftTemplate.create({
      data: {
        locationId,
        weekday: 1,
        startMinute: 7 * 60,
        endMinute: 9 * 60,
        capacity,
        weekOfMonth: 0,
      },
    });
  }

  describe('padrón de participantes', () => {
    it('importa nombres y teléfonos en distintos formatos', async () => {
      const csv = [
        'nombre,telefono,rol',
        'Ana López,5512345678,participante',
        'Beto Ruiz,+52 55 8765 4321,participante',
        'Elena Mora,5215599887766,encargado',
      ].join('\n');

      const result = await importer.importParticipants(csv, { locationId });

      expect(result.created).toBe(3);
      expect(result.errors).toHaveLength(0);

      const elena = await ctx.prisma.participant.findFirstOrThrow({
        where: { fullName: 'Elena Mora' },
      });
      expect(elena.role).toBe('SUPERVISOR');
      // El "1" que agrega WhatsApp a los móviles mexicanos se normaliza.
      expect(elena.phoneE164).toBe('+525599887766');
    });

    it('reporta todos los errores juntos, sin detenerse en el primero', async () => {
      const csv = [
        'nombre,telefono',
        ',5512345678',
        'Beto Ruiz,',
        'Carla Díaz,123',
        'Dora Sosa,5512345679',
      ].join('\n');

      const result = await importer.importParticipants(csv, { locationId });

      expect(result.processed).toBe(4);
      expect(result.created).toBe(1);
      expect(result.errors).toHaveLength(3);
      expect(result.errors.map((error) => error.row)).toEqual([2, 3, 4]);
      expect(result.errors[0].message).toContain('nombre');
      expect(result.errors[1].message).toContain('teléfono');
      expect(result.errors[2].message).toContain('no es válido');
    });

    it('el modo de prueba no escribe nada', async () => {
      const csv = 'nombre,telefono\nAna López,5512345678';

      const result = await importer.importParticipants(csv, { locationId, dryRun: true });

      expect(result.created).toBe(1);
      expect(result.dryRun).toBe(true);
      expect(await ctx.prisma.participant.count()).toBe(0);
    });

    it('actualiza en lugar de duplicar si el teléfono ya existe', async () => {
      await createParticipant(ctx.prisma, locationId, 'Ana Vieja');
      const ana = await ctx.prisma.participant.findFirstOrThrow();

      const csv = `nombre,telefono\nAna Nueva,${ana.phoneE164}`;
      const result = await importer.importParticipants(csv, { locationId });

      expect(result.created).toBe(0);
      expect(result.updated).toBe(1);
      expect(await ctx.prisma.participant.count()).toBe(1);
      const actualizada = await ctx.prisma.participant.findFirstOrThrow();
      expect(actualizada.fullName).toBe('Ana Nueva');
    });

    it('rechaza un rol desconocido en vez de asumir uno', async () => {
      const csv = 'nombre,telefono,rol\nAna López,5512345678,jefe';
      const result = await importer.importParticipants(csv, { locationId });

      expect(result.created).toBe(0);
      expect(result.errors[0].message).toContain('Rol desconocido');
    });

    it('respeta la preferencia de avisos de vacantes', async () => {
      const csv = 'nombre,telefono,alertas\nAna López,5512345678,no';
      await importer.importParticipants(csv, { locationId });

      const ana = await ctx.prisma.participant.findFirstOrThrow();
      expect(ana.coverageAlerts).toBe(false);
    });
  });

  describe('asignaciones fijas', () => {
    it('asigna titulares a su turno habitual', async () => {
      await plantillaLunes();
      await importer.importParticipants(
        'nombre,telefono\nAna López,5512345678\nBeto Ruiz,5512345679',
        { locationId },
      );

      const csv = [
        'telefono,dia,inicio',
        '5512345678,lunes,7:00',
        '5512345679,lunes,7',
      ].join('\n');

      const result = await importer.importRecurringAssignments(csv, { locationId });

      expect(result.created).toBe(2);
      expect(result.errors).toHaveLength(0);
      expect(await ctx.prisma.recurringAssignment.count()).toBe(2);
    });

    it('acepta los días con y sin acento', async () => {
      await ctx.prisma.shiftTemplate.create({
        data: {
          locationId,
          weekday: 3,
          startMinute: 9 * 60,
          endMinute: 11 * 60,
          capacity: 3,
          weekOfMonth: 0,
        },
      });
      await importer.importParticipants('nombre,telefono\nAna López,5512345678', { locationId });

      const result = await importer.importRecurringAssignments(
        'telefono,dia,inicio\n5512345678,miercoles,9:00',
        { locationId },
      );

      expect(result.created).toBe(1);
    });

    it('distingue el ordinal del mes para sábados y domingos', async () => {
      await ctx.prisma.shiftTemplate.create({
        data: {
          locationId,
          weekday: 6,
          startMinute: 7 * 60,
          endMinute: 9 * 60,
          capacity: 3,
          weekOfMonth: 5,
          autoFillOnly: false,
        },
      });
      await importer.importParticipants('nombre,telefono\nAna López,5512345678', { locationId });

      const quintoSabado = await importer.importRecurringAssignments(
        'telefono,dia,inicio,semana\n5512345678,sabado,7:00,5',
        { locationId },
      );
      expect(quintoSabado.created).toBe(1);

      // El mismo día y hora sin ordinal no existe: son plantillas distintas.
      const todasLasSemanas = await importer.importRecurringAssignments(
        'telefono,dia,inicio,semana\n5512345678,sabado,7:00,0',
        { locationId },
      );
      expect(todasLasSemanas.errors[0].message).toContain('No existe un turno');
    });

    it('avisa cuando el participante no está en el padrón', async () => {
      await plantillaLunes();
      const result = await importer.importRecurringAssignments(
        'telefono,dia,inicio\n5512345678,lunes,7:00',
        { locationId },
      );

      expect(result.errors[0].message).toContain('Impórtalo primero');
    });

    it('impide sentar más titulares que lugares tiene el turno', async () => {
      await plantillaLunes(2);
      await importer.importParticipants(
        'nombre,telefono\nAna,5512345678\nBeto,5512345679\nCarla,5512345670',
        { locationId },
      );

      const result = await importer.importRecurringAssignments(
        [
          'telefono,dia,inicio',
          '5512345678,lunes,7:00',
          '5512345679,lunes,7:00',
          '5512345670,lunes,7:00',
        ].join('\n'),
        { locationId },
      );

      expect(result.created).toBe(2);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('ya tiene 2 titulares');
    });

    it('rechaza días y horas mal escritos', async () => {
      await plantillaLunes();
      await importer.importParticipants('nombre,telefono\nAna,5512345678', { locationId });

      const result = await importer.importRecurringAssignments(
        ['telefono,dia,inicio', '5512345678,lunez,7:00', '5512345678,lunes,25:00'].join('\n'),
        { locationId },
      );

      expect(result.errors).toHaveLength(2);
      expect(result.errors[0].message).toContain('Día desconocido');
      expect(result.errors[1].message).toContain('Hora de inicio inválida');
    });
  });
});
