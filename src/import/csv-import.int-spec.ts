import { MaritalStatus, ParticipantRole, ParticipantStatus } from '@prisma/client';
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

  describe('formato del archivo', () => {
    it('acepta punto y coma, que es lo que genera Excel en español', async () => {
      const result = await importer.importParticipants(
        'nombre;apellido_paterno;telefono\nAna;López;5512345678',
        { locationId },
      );

      expect(result.errors).toHaveLength(0);
      expect(result.created).toBe(1);
      const ana = await ctx.prisma.participant.findFirstOrThrow();
      expect(ana.firstName).toBe('Ana');
      expect(ana.paternalSurname).toBe('López');
    });

    it('acepta tabuladores', async () => {
      const result = await importer.importParticipants(
        'nombre\tapellido_paterno\ttelefono\nAna\tLópez\t5512345678',
        { locationId },
      );

      expect(result.errors).toHaveLength(0);
      expect(result.created).toBe(1);
    });

    it('acepta la marca de bytes que agregan Excel y Google Sheets', async () => {
      const result = await importer.importParticipants(
        '\uFEFFnombre,apellido_paterno,telefono\nAna,López,5512345678',
        { locationId },
      );

      expect(result.errors).toHaveLength(0);
      expect(result.created).toBe(1);
    });

    it('acepta saltos de línea de Windows y encabezados con mayúsculas', async () => {
      const result = await importer.importParticipants(
        'Nombre, Apellido_Paterno , TELEFONO\r\nAna,López,5512345678\r\n',
        { locationId },
      );

      expect(result.errors).toHaveLength(0);
      expect(result.created).toBe(1);
    });

    it('no confunde un punto y coma dentro de un valor entrecomillado', async () => {
      const result = await importer.importParticipants(
        'nombre,apellido_paterno,telefono\nAna,"López;Pérez",5512345678',
        { locationId },
      );

      expect(result.errors).toHaveLength(0);
      const ana = await ctx.prisma.participant.findFirstOrThrow();
      expect(ana.paternalSurname).toBe('López;Pérez');
    });

    it('avisa de un encabezado irreconocible en vez de culpar a cada fila', async () => {
      // Antes, un encabezado que no se podía leer hacía que todas las filas
      // reportaran «Falta el nombre», sin pista de la causa real.
      const result = await importer.importParticipants(
        'persona|apellido|movil\nAna|López|5512345678',
        { locationId },
      );

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].row).toBe(1);
      expect(result.errors[0].message).toContain('No se reconoció ninguna columna');
      expect(result.errors[0].message).toContain('punto y coma o tabuladores');
    });

    it('avisa cuando el archivo solo trae el encabezado', async () => {
      const result = await importer.importParticipants('nombre,apellido_paterno,telefono', {
        locationId,
      });

      expect(result.errors[0].message).toContain('solo el encabezado');
      expect(result.created).toBe(0);
    });

    it('las asignaciones fijas también aceptan punto y coma', async () => {
      await plantillaLunes();
      await importer.importParticipants('nombre,apellido_paterno,telefono\nAna,López,5512345678', {
        locationId,
      });

      const result = await importer.importRecurringAssignments(
        'telefono;dia;inicio\n5512345678;lunes;7:00',
        { locationId },
      );

      expect(result.errors).toHaveLength(0);
      expect(result.created).toBe(1);
    });
  });

  describe('errores identificables', () => {
    it('dice de quién es la fila que falló, no solo su número', async () => {
      const csv = [
        'nombre,apellido_paterno,telefono,estado_civil',
        'Ana,López,5512345678,casada',
        'Ramón,Gutiérrez,5512345679,comprometido',
      ].join('\n');

      const result = await importer.importParticipants(csv, { locationId });

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].row).toBe(3);
      // Sin la etiqueta habría que contar renglones en la hoja para saber a
      // quién corregir.
      expect(result.errors[0].label).toBe('Ramón Gutiérrez · 5512345679');
    });

    it('etiqueta también la fila a la que le falta el nombre', async () => {
      const result = await importer.importParticipants(
        'nombre,apellido_paterno,telefono\n,Gutiérrez,5512345679',
        { locationId },
      );

      expect(result.errors[0].label).toContain('Gutiérrez');
      expect(result.errors[0].label).toContain('5512345679');
    });

    it('etiqueta los errores del cónyuge, que salen en la segunda pasada', async () => {
      const csv = [
        'nombre,apellido_paterno,telefono,estado_civil,conyuge_telefono',
        'Ana,López,5512345678,casada,5599998888',
      ].join('\n');

      const result = await importer.importParticipants(csv, { locationId });

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].label).toBe('Ana López · 5512345678');
    });

    it('no se queda sin etiqueta cuando la fila viene vacía de datos legibles', async () => {
      const result = await importer.importParticipants('nombre,apellido_paterno,telefono\n,,', {
        locationId,
      });

      expect(result.errors[0].label).toBe('(fila sin datos legibles)');
    });
  });

  describe('rendimiento con un padrón completo', () => {
    it('importa 130 filas sin consultar los valores conocidos en cada una', async () => {
      const filas = ['nombre,apellido_paterno,telefono,congregacion,circuito,ciudad'];
      for (let i = 0; i < 130; i += 1) {
        const telefono = `55${String(10000000 + i).padStart(8, '0')}`;
        filas.push(`Persona${i},Apellido${i},${telefono},Centro,Monterrey 14,Monterrey`);
      }

      const inicio = Date.now();
      const result = await importer.importParticipants(filas.join('\n'), { locationId });
      const duracion = Date.now() - inicio;

      expect(result.created).toBe(130);
      expect(result.errors).toHaveLength(0);
      // Antes, cada fila consultaba la base tres veces solo para normalizar
      // congregación, circuito y ciudad. Contra una base remota eso bastaba para
      // que el proxy cortara la petición.
      expect(duracion).toBeLessThan(15_000);
    });

    it('importa 250 asignaciones fijas con un puñado de consultas', async () => {
      // Dos franjas por persona, que es lo realista. Antes cada fila hacía cinco
      // viajes a la base, así que un archivo así sumaba más de mil: contra una
      // base remota el proxy cortaba la petición antes de terminar.
      const plantillas = [];
      for (let dia = 1; dia <= 5; dia += 1) {
        for (const hora of [7, 9, 11, 13, 15]) {
          plantillas.push(
            await ctx.prisma.shiftTemplate.create({
              data: {
                locationId,
                weekday: dia,
                startMinute: hora * 60,
                endMinute: (hora + 2) * 60,
                capacity: 25,
                weekOfMonth: 0,
              },
            }),
          );
        }
      }

      const padron = ['nombre,apellido_paterno,telefono'];
      for (let i = 0; i < 125; i += 1) {
        padron.push(`Persona${i},Apellido${i},55${String(10000000 + i).padStart(8, '0')}`);
      }
      await importer.importParticipants(padron.join('\n'), { locationId });

      const dias = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
      const filas = ['telefono,dia,inicio,semana'];
      for (let i = 0; i < 125; i += 1) {
        const telefono = `55${String(10000000 + i).padStart(8, '0')}`;
        for (const k of [0, 1]) {
          const plantilla = plantillas[(i * 2 + k) % plantillas.length];
          const hora = Math.floor(plantilla.startMinute / 60);
          filas.push(`${telefono},${dias[plantilla.weekday]},${hora}:00,`);
        }
      }

      const inicio = Date.now();
      const result = await importer.importRecurringAssignments(filas.join('\n'), { locationId });
      const duracion = Date.now() - inicio;

      expect(result.created).toBe(250);
      expect(result.errors).toHaveLength(0);
      expect(await ctx.prisma.recurringAssignment.count()).toBe(250);
      expect(duracion).toBeLessThan(15_000);
    });

    it('sigue alineando las grafías dentro del archivo, ahora en memoria', async () => {
      const csv = [
        'nombre,apellido_paterno,telefono,ciudad',
        'Ana,López,5512345678,Querétaro',
        'Beto,Ruiz,5512345679,queretaro',
        'Carla,Díaz,5512345670,QUERÉTARO',
      ].join('\n');

      await importer.importParticipants(csv, { locationId });

      const ciudades = await ctx.prisma.participant.findMany({ select: { city: true } });
      expect(new Set(ciudades.map((p) => p.city))).toEqual(new Set(['Querétaro']));
    });
  });

  describe('padrón de participantes', () => {
    it('importa nombres y teléfonos en distintos formatos', async () => {
      const csv = [
        'nombre,apellido_paterno,apellido_materno,telefono,rol',
        'Ana,López,Pérez,5512345678,participante',
        'Beto,Ruiz,,+52 55 8765 4321,participante',
        'Elena,Mora,Solís,5215599887766,encargado',
      ].join('\n');

      const result = await importer.importParticipants(csv, { locationId });

      expect(result.created).toBe(3);
      expect(result.errors).toHaveLength(0);

      const elena = await ctx.prisma.participant.findFirstOrThrow({
        where: { firstName: 'Elena' },
        include: { memberships: true },
      });
      // El rol vive en el vínculo con el punto, no en la persona.
      expect(elena.memberships[0].role).toBe('SUPERVISOR');
      // El "1" que agrega WhatsApp a los móviles mexicanos se normaliza.
      expect(elena.phoneE164).toBe('+525599887766');
    });

    it('acepta a quien usa un solo apellido', async () => {
      const result = await importer.importParticipants(
        'nombre,apellido_paterno,apellido_materno,telefono\nJohn,Smith,,5512345678',
        { locationId },
      );

      expect(result.errors).toHaveLength(0);
      const john = await ctx.prisma.participant.findFirstOrThrow();
      expect(john.paternalSurname).toBe('Smith');
      expect(john.maternalSurname).toBeNull();
    });

    it('guarda el nombre a mostrar cuando viene en el archivo', async () => {
      await importer.importParticipants(
        'nombre,apellido_paterno,telefono,nombre_a_mostrar\nAna María,López,5512345678,Anita',
        { locationId },
      );

      const ana = await ctx.prisma.participant.findFirstOrThrow();
      expect(ana.firstName).toBe('Ana María');
      expect(ana.displayName).toBe('Anita');
    });

    it('rechaza el formato anterior en vez de meter el apellido dentro del nombre', async () => {
      // Un archivo viejo traía «Ana López» en la columna `nombre`. Aceptarlo
      // callando guardaría el apellido como parte del nombre y nadie lo notaría
      // hasta ver un saludo equivocado.
      const result = await importer.importParticipants('nombre,telefono\nAna López,5512345678', {
        locationId,
      });

      expect(result.created).toBe(0);
      expect(result.errors[0].message).toContain('Falta el apellido paterno');
      expect(result.errors[0].message).toContain('tres columnas');
    });

    it('ordena el padrón por apellido paterno', async () => {
      const csv = [
        'nombre,apellido_paterno,telefono',
        'Ana,Zúñiga,5512345678',
        'Beto,Álvarez,5512345679',
        'Carla,Morales,5512345670',
      ].join('\n');
      await importer.importParticipants(csv, { locationId });

      const padron = await ctx.prisma.participant.findMany({
        orderBy: [{ paternalSurname: 'asc' }, { maternalSurname: 'asc' }, { firstName: 'asc' }],
        select: { paternalSurname: true },
      });
      expect(padron.map((p) => p.paternalSurname)).toEqual(['Morales', 'Zúñiga', 'Álvarez']);
    });

    it('importa congregación, circuito y ciudad', async () => {
      const csv = [
        'nombre,apellido_paterno,telefono,congregacion,circuito,ciudad',
        'Ana,López,5512345678,Centro,Monterrey 14,Monterrey',
        'Beto,Ruiz,5512345679,Valle,Monterrey 14,Monterrey',
      ].join('\n');

      const result = await importer.importParticipants(csv, { locationId });

      expect(result.errors).toHaveLength(0);
      const ana = await ctx.prisma.participant.findFirstOrThrow({ where: { firstName: 'Ana' } });
      expect(ana.congregation).toBe('Centro');
      expect(ana.circuit).toBe('Monterrey 14');
      expect(ana.city).toBe('Monterrey');
    });

    it('alinea las grafías equivalentes dentro del mismo archivo', async () => {
      const csv = [
        'nombre,apellido_paterno,telefono,ciudad',
        'Ana,López,5512345678,Querétaro',
        'Beto,Ruiz,5512345679,queretaro',
        'Carla,Díaz,5512345670,QUERÉTARO',
      ].join('\n');

      await importer.importParticipants(csv, { locationId });

      const ciudades = await ctx.prisma.participant.findMany({ select: { city: true } });
      // Una sola grafía: el filtro por ciudad no se parte en tres.
      expect(new Set(ciudades.map((p) => p.city))).toEqual(new Set(['Querétaro']));
    });

    it('una reimportación sin esas columnas no borra lo ya capturado', async () => {
      await importer.importParticipants(
        'nombre,apellido_paterno,telefono,congregacion\nAna,López,5512345678,Centro',
        { locationId },
      );
      await importer.importParticipants('nombre,apellido_paterno,telefono\nAna,López,5512345678', {
        locationId,
      });

      const ana = await ctx.prisma.participant.findFirstOrThrow();
      expect(ana.congregation).toBe('Centro');
    });

    it('reporta todos los errores juntos, sin detenerse en el primero', async () => {
      const csv = [
        'nombre,apellido_paterno,telefono',
        ',López,5512345678',
        'Beto,Ruiz,',
        'Carla,Díaz,123',
        'Dora,Sosa,5512345679',
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
      const csv = 'nombre,apellido_paterno,telefono\nAna,López,5512345678';

      const result = await importer.importParticipants(csv, { locationId, dryRun: true });

      expect(result.created).toBe(1);
      expect(result.dryRun).toBe(true);
      expect(await ctx.prisma.participant.count()).toBe(0);
    });

    it('actualiza en lugar de duplicar si el teléfono ya existe', async () => {
      await createParticipant(ctx.prisma, locationId, 'Ana Vieja');
      const ana = await ctx.prisma.participant.findFirstOrThrow();

      const csv = `nombre,apellido_paterno,telefono\nAna,Nueva,${ana.phoneE164}`;
      const result = await importer.importParticipants(csv, { locationId });

      expect(result.created).toBe(0);
      expect(result.updated).toBe(1);
      expect(await ctx.prisma.participant.count()).toBe(1);
      const actualizada = await ctx.prisma.participant.findFirstOrThrow();
      expect(actualizada.paternalSurname).toBe('Nueva');
    });

    it('acepta las variantes de rol y estado civil que no son la forma canónica', async () => {
      // El mensaje de error y la guía del panel tienen que nombrarlas: si el
      // sistema las acepta pero nadie lo sabe, alguien edita su hoja a mano
      // creyendo que van a fallar.
      const csv = [
        'nombre,apellido_paterno,telefono,rol,estado_civil',
        'Ana,López,5512345678,encargada,divorciada',
        'Beto,Ruiz,5512345679,administrador,divorciado',
      ].join('\n');

      const result = await importer.importParticipants(csv, { locationId });

      expect(result.errors).toHaveLength(0);
      const personas = await ctx.prisma.participant.findMany({
        include: { memberships: true },
        orderBy: { firstName: 'asc' },
      });
      expect(personas[0].memberships[0].role).toBe(ParticipantRole.SUPERVISOR);
      expect(personas[1].memberships[0].role).toBe(ParticipantRole.ADMIN);
      // Divorciado es un estado propio: separado es una situación de hecho y
      // divorciado un estado legal, y quien lo declara distingue entre los dos.
      expect(personas.map((p) => p.maritalStatus)).toEqual([
        MaritalStatus.DIVORCIADO,
        MaritalStatus.DIVORCIADO,
      ]);
    });

    it('al rechazar un valor, el mensaje nombra todas las variantes aceptadas', async () => {
      const rol = await importer.importParticipants(
        'nombre,apellido_paterno,telefono,rol\nAna,López,5512345678,jefa',
        { locationId },
      );
      expect(rol.errors[0].message).toContain('encargada');
      expect(rol.errors[0].message).toContain('administrador');

      const civil = await importer.importParticipants(
        'nombre,apellido_paterno,telefono,estado_civil\nAna,López,5512345678,comprometida',
        { locationId },
      );
      expect(civil.errors[0].message).toContain('divorciado');
    });

    it('al actualizar, las columnas obligatorias siguen haciendo falta', async () => {
      // La guía del panel afirmaba que una columna ausente no cambia nada, y
      // eso solo vale para las opcionales: sin nombre la fila se rechaza aunque
      // la persona ya exista.
      await importer.importParticipants('nombre,apellido_paterno,telefono\nAna,López,5512345678', {
        locationId,
      });

      const result = await importer.importParticipants('telefono,ciudad\n5512345678,Toluca', {
        locationId,
      });

      expect(result.created).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.errors[0].message).toBe('Falta el nombre');
    });

    it('rechaza un rol desconocido en vez de asumir uno', async () => {
      const csv = 'nombre,apellido_paterno,telefono,rol\nAna,López,5512345678,jefe';
      const result = await importer.importParticipants(csv, { locationId });

      expect(result.created).toBe(0);
      expect(result.errors[0].message).toContain('Rol desconocido');
    });

    it('registra el consentimiento declarado al importar el padrón', async () => {
      // Sin este registro no se les podría avisar de ninguna vacante: para
      // escribirles tendrían que haber escrito antes.
      await importer.importParticipants('nombre,apellido_paterno,telefono\nAna,López,5512345678', {
        locationId,
      });

      const ana = await ctx.prisma.participant.findFirstOrThrow();
      expect(ana.optInAt).not.toBeNull();
    });

    it('respeta a quien no dio consentimiento', async () => {
      await importer.importParticipants(
        'nombre,apellido_paterno,telefono,consentimiento\nAna,López,5512345678,no',
        {
          locationId,
        },
      );

      const ana = await ctx.prisma.participant.findFirstOrThrow();
      expect(ana.optInAt).toBeNull();
    });

    it('conserva la fecha original del consentimiento al reimportar', async () => {
      await importer.importParticipants('nombre,apellido_paterno,telefono\nAna,López,5512345678', {
        locationId,
      });
      const primera = await ctx.prisma.participant.findFirstOrThrow();

      await importer.importParticipants('nombre,apellido_paterno,telefono\nAna,L.,5512345678', {
        locationId,
      });
      const segunda = await ctx.prisma.participant.findFirstOrThrow();

      expect(segunda.optInAt?.getTime()).toBe(primera.optInAt?.getTime());
    });

    it('respeta la preferencia de avisos de vacantes', async () => {
      const csv = 'nombre,apellido_paterno,telefono,alertas\nAna,López,5512345678,no';
      await importer.importParticipants(csv, { locationId });

      const ana = await ctx.prisma.participant.findFirstOrThrow({
        include: { memberships: true },
      });
      expect(ana.memberships[0].coverageAlerts).toBe(false);
    });
  });

  describe('reimportación con datos actualizados', () => {
    /** Padrón completo, tal como quedaría tras la primera carga. */
    async function cargaInicial() {
      await importer.importParticipants(
        'nombre,apellido_paterno,apellido_materno,telefono,rol,alertas\n' +
          'Ana,López,Pérez,5512345678,encargado,no',
        { locationId },
      );
      return ctx.prisma.participant.findFirstOrThrow({
        where: { paternalSurname: 'López' },
        include: { memberships: true },
      });
    }

    it('actualiza lo que viene y conserva lo que el archivo no trae', async () => {
      await cargaInicial();

      // El segundo archivo solo corrige el nombre. Las columnas que no trae no
      // son una instrucción de borrar: lo capturado a mano en el panel —el rol
      // de encargado, la preferencia de avisos, el apellido materno— tiene que
      // sobrevivir, o cada reimportación desharía ese trabajo en silencio.
      const result = await importer.importParticipants(
        'nombre,apellido_paterno,telefono\nAna María,López,5512345678',
        { locationId },
      );

      expect(result.created).toBe(0);
      expect(result.updated).toBe(1);
      expect(result.errors).toHaveLength(0);

      const ana = await ctx.prisma.participant.findFirstOrThrow({
        include: { memberships: true },
      });
      expect(ana.firstName).toBe('Ana María');
      expect(ana.maternalSurname).toBe('Pérez');
      expect(ana.memberships[0].role).toBe(ParticipantRole.SUPERVISOR);
      expect(ana.memberships[0].coverageAlerts).toBe(false);
      expect(await ctx.prisma.participant.count()).toBe(1);
    });

    it('una celda vacía tampoco borra: para quitar un dato se usa el panel', async () => {
      await cargaInicial();

      await importer.importParticipants(
        'nombre,apellido_paterno,apellido_materno,telefono,rol,alertas\n' +
          'Ana,López,,5512345678,,',
        { locationId },
      );

      const ana = await ctx.prisma.participant.findFirstOrThrow({
        include: { memberships: true },
      });
      expect(ana.maternalSurname).toBe('Pérez');
      expect(ana.memberships[0].role).toBe(ParticipantRole.SUPERVISOR);
      expect(ana.memberships[0].coverageAlerts).toBe(false);
    });

    it('un valor explícito sí sustituye al anterior', async () => {
      await cargaInicial();

      await importer.importParticipants(
        'nombre,apellido_paterno,apellido_materno,telefono,rol,alertas\n' +
          'Ana,López,Ramírez,5512345678,participante,si',
        { locationId },
      );

      const ana = await ctx.prisma.participant.findFirstOrThrow({
        include: { memberships: true },
      });
      expect(ana.maternalSurname).toBe('Ramírez');
      expect(ana.memberships[0].role).toBe(ParticipantRole.PARTICIPANT);
      expect(ana.memberships[0].coverageAlerts).toBe(true);
    });

    it('agrupa sin mezclar a quien trae valores con quien no los trae', async () => {
      // Las membresías se actualizan agrupadas por valor para no hacer una
      // consulta por persona. El riesgo es que el grupo de «no tocar» arrastre
      // el valor de otra fila, así que se comprueba con las dos cosas juntas.
      await importer.importParticipants(
        'nombre,apellido_paterno,telefono,rol,alertas\n' +
          'Ana,López,5512345678,encargado,no\n' +
          'Beto,Ruiz,5512345679,encargado,no',
        { locationId },
      );

      await importer.importParticipants(
        'nombre,apellido_paterno,telefono,rol\n' +
          'Ana,López,5512345678,participante\n' +
          'Beto,Ruiz,5512345679,',
        { locationId },
      );

      const ana = await ctx.prisma.participant.findFirstOrThrow({
        where: { firstName: 'Ana' },
        include: { memberships: true },
      });
      const beto = await ctx.prisma.participant.findFirstOrThrow({
        where: { firstName: 'Beto' },
        include: { memberships: true },
      });

      expect(ana.memberships[0].role).toBe(ParticipantRole.PARTICIPANT);
      expect(beto.memberships[0].role).toBe(ParticipantRole.SUPERVISOR);
      // La preferencia de avisos no venía en ninguna de las dos filas.
      expect(ana.memberships[0].coverageAlerts).toBe(false);
      expect(beto.memberships[0].coverageAlerts).toBe(false);
    });

    it('un teléfono distinto es otra persona, no una actualización', async () => {
      await cargaInicial();

      // El teléfono es la clave: cambiarlo en el archivo no renombra a nadie,
      // da de alta a alguien más. Un cambio de número se hace en el panel.
      const result = await importer.importParticipants(
        'nombre,apellido_paterno,telefono\nAna,López,5599998888',
        { locationId },
      );

      expect(result.created).toBe(1);
      expect(result.updated).toBe(0);
      expect(await ctx.prisma.participant.count()).toBe(2);
    });

    it('no toca a quien no viene en el archivo nuevo', async () => {
      await importer.importParticipants(
        'nombre,apellido_paterno,telefono\nAna,López,5512345678\nBeto,Ruiz,5512345679',
        { locationId },
      );

      await importer.importParticipants('nombre,apellido_paterno,telefono\nAna,López,5512345678', {
        locationId,
      });

      // Un archivo parcial no es una lista de bajas: Beto sigue activo.
      const beto = await ctx.prisma.participant.findFirstOrThrow({
        where: { firstName: 'Beto' },
        include: { memberships: true },
      });
      expect(beto.status).toBe(ParticipantStatus.ACTIVE);
      expect(beto.memberships[0].active).toBe(true);
    });
  });

  describe('estado civil y cónyuge', () => {
    it('importa el estado civil escrito en español, con o sin género', async () => {
      const csv = [
        'nombre,apellido_paterno,telefono,estado_civil',
        'Ana,López,5512345678,casada',
        'Beto,Ruiz,5512345679,soltero',
        'Carla,Díaz,5512345670,viuda',
        'Dora,Sosa,5512345671,separada',
        'Elia,Nava,5512345673,divorciada',
        'Elsa,Vega,5512345672,',
      ].join('\n');

      const result = await importer.importParticipants(csv, { locationId });

      expect(result.errors).toHaveLength(0);
      const estados = await ctx.prisma.participant.findMany({
        select: { firstName: true, maritalStatus: true },
        orderBy: { firstName: 'asc' },
      });
      expect(estados).toEqual([
        { firstName: 'Ana', maritalStatus: 'CASADO' },
        { firstName: 'Beto', maritalStatus: 'SOLTERO' },
        { firstName: 'Carla', maritalStatus: 'VIUDO' },
        { firstName: 'Dora', maritalStatus: 'SEPARADO' },
        { firstName: 'Elia', maritalStatus: 'DIVORCIADO' },
        // Columna vacía: queda sin registrar, no como soltera.
        { firstName: 'Elsa', maritalStatus: 'SIN_REGISTRAR' },
      ]);
    });

    it('rechaza un estado civil que no reconoce', async () => {
      const result = await importer.importParticipants(
        'nombre,apellido_paterno,telefono,estado_civil\nAna,López,5512345678,comprometida',
        { locationId },
      );

      expect(result.created).toBe(0);
      expect(result.errors[0].message).toContain('Estado civil desconocido');
    });

    it('vincula a dos participantes casados entre sí', async () => {
      const csv = [
        'nombre,apellido_paterno,telefono,estado_civil,conyuge_telefono',
        'Ana,López,5512345678,casada,5512345679',
        'Beto,Ruiz,5512345679,casado,5512345678',
      ].join('\n');

      const result = await importer.importParticipants(csv, { locationId });

      expect(result.errors).toHaveLength(0);
      const ana = await ctx.prisma.participant.findFirstOrThrow({
        where: { firstName: 'Ana' },
      });
      const beto = await ctx.prisma.participant.findFirstOrThrow({
        where: { firstName: 'Beto' },
      });
      expect(ana.spouseId).toBe(beto.id);
      expect(beto.spouseId).toBe(ana.id);
    });

    it('vincula aunque el cónyuge aparezca más abajo en el archivo', async () => {
      // Ana declara a Beto en la primera fila, cuando Beto todavía no existe.
      const csv = [
        'nombre,apellido_paterno,telefono,estado_civil,conyuge_telefono',
        'Ana,López,5512345678,casada,5512345679',
        'Beto,Ruiz,5512345679,casado,',
      ].join('\n');

      const result = await importer.importParticipants(csv, { locationId });

      expect(result.errors).toHaveLength(0);
      const ana = await ctx.prisma.participant.findFirstOrThrow({
        where: { firstName: 'Ana' },
      });
      const beto = await ctx.prisma.participant.findFirstOrThrow({
        where: { firstName: 'Beto' },
      });
      expect(ana.spouseId).toBe(beto.id);
      expect(beto.spouseId).toBe(ana.id);
    });

    it('anota solo el nombre cuando el cónyuge no participa', async () => {
      const result = await importer.importParticipants(
        'nombre,apellido_paterno,telefono,estado_civil,conyuge\nAna,López,5512345678,casada,Julio Hernández',
        { locationId },
      );

      expect(result.errors).toHaveLength(0);
      const ana = await ctx.prisma.participant.findFirstOrThrow();
      expect(ana.spouseName).toBe('Julio Hernández');
      expect(ana.spouseId).toBeNull();
      // No se da de alta a nadie por el cónyuge que no participa.
      expect(await ctx.prisma.participant.count()).toBe(1);
    });

    it('avisa cuando el teléfono del cónyuge no está en el padrón', async () => {
      const result = await importer.importParticipants(
        'nombre,apellido_paterno,telefono,estado_civil,conyuge_telefono\nAna,López,5512345678,casada,5599998888',
        { locationId },
      );

      expect(result.created).toBe(1);
      expect(result.errors[0].message).toContain('Inclúyelo en el archivo o anota solo su nombre');
    });

    it('rechaza indicar cónyuge si el estado civil no es casado', async () => {
      const result = await importer.importParticipants(
        'nombre,apellido_paterno,telefono,estado_civil,conyuge\nAna,López,5512345678,soltera,Julio Hernández',
        { locationId },
      );

      expect(result.created).toBe(0);
      expect(result.errors[0].message).toContain('el estado civil no es «casado»');
    });

    it('reporta el conflicto en su fila y sigue con el resto del archivo', async () => {
      const csv = [
        'nombre,apellido_paterno,telefono,estado_civil,conyuge_telefono',
        'Ana,López,5512345678,casada,5512345679',
        'Beto,Ruiz,5512345679,casado,5512345678',
        // Carla declara a Beto, que ya quedó casado con Ana.
        'Carla,Díaz,5512345670,casada,5512345679',
        'Dora,Sosa,5512345671,soltera,',
      ].join('\n');

      const result = await importer.importParticipants(csv, { locationId });

      expect(result.created).toBe(4);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].row).toBe(4);
      expect(result.errors[0].message).toContain('ya figura casado');
      // Dora, en la fila siguiente, se importó sin problema.
      const dora = await ctx.prisma.participant.findFirstOrThrow({
        where: { firstName: 'Dora' },
      });
      expect(dora.maritalStatus).toBe('SOLTERO');
    });

    it('una reimportación sin la columna no borra el estado ya capturado', async () => {
      await importer.importParticipants(
        'nombre,apellido_paterno,telefono,estado_civil\nAna,López,5512345678,casada',
        { locationId },
      );
      await importer.importParticipants('nombre,apellido_paterno,telefono\nAna,López,5512345678', {
        locationId,
      });

      const ana = await ctx.prisma.participant.findFirstOrThrow();
      expect(ana.maritalStatus).toBe('CASADO');
    });

    it('el modo de prueba no crea vínculos', async () => {
      const csv = [
        'nombre,apellido_paterno,telefono,estado_civil,conyuge_telefono',
        'Ana,López,5512345678,casada,5512345679',
        'Beto,Ruiz,5512345679,casado,5512345678',
      ].join('\n');

      await importer.importParticipants(csv, { locationId, dryRun: true });

      expect(await ctx.prisma.participant.count()).toBe(0);
    });
  });

  describe('asignaciones fijas', () => {
    it('asigna titulares a su turno habitual', async () => {
      await plantillaLunes();
      await importer.importParticipants(
        'nombre,apellido_paterno,telefono\nAna,López,5512345678\nBeto,Ruiz,5512345679',
        { locationId },
      );

      const csv = ['telefono,dia,inicio', '5512345678,lunes,7:00', '5512345679,lunes,7'].join('\n');

      const result = await importer.importRecurringAssignments(csv, { locationId });

      expect(result.created).toBe(2);
      expect(result.errors).toHaveLength(0);
      expect(await ctx.prisma.recurringAssignment.count()).toBe(2);
    });

    it('toma varias filas con el mismo teléfono como varios turnos fijos', async () => {
      // Una persona atiende más de una franja: se repite su teléfono en tantas
      // filas como franjas tenga. El archivo no lleva una fila por persona.
      await plantillaLunes();
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
      await ctx.prisma.shiftTemplate.create({
        data: {
          locationId,
          weekday: 6,
          startMinute: 9 * 60,
          endMinute: 11 * 60,
          capacity: 3,
          weekOfMonth: 2,
        },
      });
      await importer.importParticipants('nombre,apellido_paterno,telefono\nAna,López,5512345678', {
        locationId,
      });

      const csv = [
        'telefono,dia,inicio,semana',
        '5512345678,lunes,7:00,',
        '5512345678,miercoles,9:00,0',
        '5512345678,sabado,9:00,2',
      ].join('\n');

      const result = await importer.importRecurringAssignments(csv, { locationId });

      expect(result.created).toBe(3);
      expect(result.errors).toHaveLength(0);

      const titular = await ctx.prisma.participant.findFirstOrThrow({
        where: { firstName: 'Ana' },
      });
      const franjas = await ctx.prisma.recurringAssignment.findMany({
        where: { participantId: titular.id, active: true },
        include: { shiftTemplate: true },
      });
      expect(
        franjas
          .map((franja) => `${franja.shiftTemplate.weekday}:${franja.shiftTemplate.weekOfMonth}`)
          .sort(),
      ).toEqual(['1:0', '3:0', '6:2']);
    });

    it('repetir la misma franja no duplica el turno fijo', async () => {
      // Un archivo con la fila duplicada no debe reventar ni crear dos
      // titulares de la misma persona: la segunda vuelve a activar la primera.
      await plantillaLunes();
      await importer.importParticipants('nombre,apellido_paterno,telefono\nAna,López,5512345678', {
        locationId,
      });

      const result = await importer.importRecurringAssignments(
        'telefono,dia,inicio\n5512345678,lunes,7:00\n5512345678,lunes,7:00',
        { locationId },
      );

      expect(result.created).toBe(1);
      expect(result.updated).toBe(1);
      expect(result.errors).toHaveLength(0);
      expect(await ctx.prisma.recurringAssignment.count()).toBe(1);
    });

    it('dice de quién es la fila fallida, no solo su teléfono', async () => {
      // Con cientos de filas, un teléfono suelto obliga a buscar a quién
      // pertenece antes de poder corregir nada. El padrón ya está precargado,
      // así que el nombre no cuesta una consulta extra.
      await importer.importParticipants(
        'nombre,apellido_paterno,apellido_materno,telefono\nAna,López,Pérez,5512345678',
        { locationId },
      );

      const result = await importer.importRecurringAssignments(
        'telefono,dia,inicio\n5512345678,lunes,7:00',
        { locationId },
      );

      // No hay plantilla de lunes a las 7, así que la fila falla con nombre.
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].label).toBe('López Pérez, Ana · 5512345678');
    });

    it('cuando el teléfono no está en el padrón, cita el número como se escribió', async () => {
      const result = await importer.importRecurringAssignments(
        'telefono,dia,inicio\n55 1234 5678,lunes,7:00',
        { locationId },
      );

      expect(result.errors[0].message).toContain('55 1234 5678');
      expect(result.errors[0].label).toBe('55 1234 5678');
    });

    it('acepta la hora sin minutos y con cero a la izquierda', async () => {
      await plantillaLunes();
      await ctx.prisma.shiftTemplate.create({
        data: {
          locationId,
          weekday: 1,
          startMinute: 11 * 60 + 30,
          endMinute: 13 * 60 + 30,
          capacity: 3,
          weekOfMonth: 0,
        },
      });
      await importer.importParticipants(
        'nombre,apellido_paterno,telefono\nAna,López,5512345678\nBeto,Ruiz,5512345679',
        { locationId },
      );

      const result = await importer.importRecurringAssignments(
        ['telefono,dia,inicio', '5512345678,lunes,7', '5512345679,lunes,07:00'].join('\n'),
        { locationId },
      );
      expect(result.created).toBe(2);
      expect(result.errors).toHaveLength(0);

      // Y los minutos no se pierden por el camino.
      const media = await importer.importRecurringAssignments(
        'telefono,dia,inicio\n5512345678,lunes,11:30',
        { locationId },
      );
      expect(media.created).toBe(1);
      expect(media.errors).toHaveLength(0);
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
      await importer.importParticipants('nombre,apellido_paterno,telefono\nAna,López,5512345678', {
        locationId,
      });

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
      await importer.importParticipants('nombre,apellido_paterno,telefono\nAna,López,5512345678', {
        locationId,
      });

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
        'nombre,apellido_paterno,telefono\nAna,Uno,5512345678\nBeto,Dos,5512345679\nCarla,Tres,5512345670',
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
      await importer.importParticipants('nombre,apellido_paterno,telefono\nAna,Prueba,5512345678', {
        locationId,
      });

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
