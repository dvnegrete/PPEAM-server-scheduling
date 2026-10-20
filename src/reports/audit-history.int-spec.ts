import { ActorType } from '@prisma/client';
import { createLocation, createParticipant } from '../../test/helpers/fixtures';
import { createFullTestContext, resetDatabase, TestContext } from '../../test/helpers/test-context';
import { AUDIT_ACTIONS } from '../audit/audit.service';
import { ReportsService } from './reports.service';

describe('Bitácora consultable (integración)', () => {
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
  });

  /** Una entrada de bitácora con el instante exacto que haga falta. */
  function registrar(params: {
    action: string;
    createdAt: Date;
    actorName?: string | null;
    actorType?: ActorType;
    entity?: string;
    entityId?: string | null;
    metadata?: object | null;
  }) {
    return ctx.prisma.auditLog.create({
      data: {
        action: params.action,
        actorType: params.actorType ?? ActorType.ADMIN,
        actorName: params.actorName ?? 'Elena Mora',
        entity: params.entity ?? 'Shift',
        entityId: params.entityId ?? null,
        metadata: params.metadata ?? undefined,
        createdAt: params.createdAt,
      },
    });
  }

  /** `n` entradas separadas por un minuto, de la más vieja a la más nueva. */
  async function registrarSerie(n: number, action = AUDIT_ACTIONS.SHIFT_GENERATED) {
    for (let i = 0; i < n; i += 1) {
      await registrar({ action, createdAt: new Date(Date.UTC(2026, 8, 1, 10, i, 0)) });
    }
  }

  const consulta = (extra: Partial<Parameters<ReportsService['auditHistory']>[0]> = {}) =>
    reports.auditHistory({ limit: 50, verSensibles: true, ...extra });

  describe('orden y paginación', () => {
    it('devuelve lo más reciente primero', async () => {
      await registrarSerie(3);

      const pagina = await consulta();

      const fechas = pagina.entries.map((entrada) => entrada.at);
      expect(fechas).toEqual([...fechas].sort().reverse());
      expect(pagina.nextCursor).toBeNull();
    });

    it('avisa de que hay más página y no la incluye', async () => {
      await registrarSerie(5);

      const primera = await consulta({ limit: 2 });

      expect(primera.entries).toHaveLength(2);
      expect(primera.nextCursor).not.toBeNull();
    });

    it('recorre el histórico completo sin repetir ni saltarse nada', async () => {
      await registrarSerie(7);

      const vistas: string[] = [];
      let cursor: string | null | undefined;
      do {
        const pagina = await consulta({ limit: 3, cursor: cursor ?? undefined });
        vistas.push(...pagina.entries.map((entrada) => entrada.id));
        cursor = pagina.nextCursor;
      } while (cursor);

      expect(vistas).toHaveLength(7);
      expect(new Set(vistas).size).toBe(7);
    });

    // Es la razón de usar cursor en vez de `skip`: con un desplazamiento, la
    // entrada nueva correría la ventana y la segunda página repetiría una fila.
    it('no se descoloca si se registra algo nuevo entre dos páginas', async () => {
      await registrarSerie(4);

      const primera = await consulta({ limit: 2 });
      await registrar({
        action: AUDIT_ACTIONS.ASSIGNMENT_CREATED,
        createdAt: new Date(Date.UTC(2026, 8, 1, 23, 0, 0)),
      });
      const segunda = await consulta({ limit: 2, cursor: primera.nextCursor ?? undefined });

      const ids = [...primera.entries, ...segunda.entries].map((entrada) => entrada.id);
      expect(new Set(ids).size).toBe(4);
      expect(segunda.entries).toHaveLength(2);
    });

    it('desempata por id las entradas con el mismo instante', async () => {
      // Pasa de verdad: varias acciones se registran en una misma transacción.
      const mismoInstante = new Date(Date.UTC(2026, 8, 1, 10, 0, 0));
      await registrar({ action: AUDIT_ACTIONS.COVERAGE_OPENED, createdAt: mismoInstante });
      await registrar({ action: AUDIT_ACTIONS.COVERAGE_BROADCAST, createdAt: mismoInstante });
      await registrar({ action: AUDIT_ACTIONS.COVERAGE_OFFERED, createdAt: mismoInstante });

      const vistas: string[] = [];
      let cursor: string | null | undefined;
      do {
        const pagina = await consulta({ limit: 1, cursor: cursor ?? undefined });
        vistas.push(...pagina.entries.map((entrada) => entrada.id));
        cursor = pagina.nextCursor;
      } while (cursor);

      expect(new Set(vistas).size).toBe(3);
    });

    it('rechaza un cursor ilegible en vez de devolver la primera página', async () => {
      await registrarSerie(2);

      await expect(consulta({ cursor: 'basura' })).rejects.toThrow(/cursor/i);
      await expect(consulta({ cursor: 'no-es-fecha|abc' })).rejects.toThrow(/cursor/i);
    });
  });

  describe('filtros', () => {
    it('acota por rango de fechas', async () => {
      await registrar({
        action: AUDIT_ACTIONS.SHIFT_GENERATED,
        createdAt: new Date('2026-07-15T10:00:00.000Z'),
      });
      await registrar({
        action: AUDIT_ACTIONS.SHIFT_GENERATED,
        createdAt: new Date('2026-09-15T10:00:00.000Z'),
      });

      const pagina = await consulta({
        from: new Date('2026-09-01T00:00:00.000Z'),
        to: new Date('2026-09-30T23:59:59.000Z'),
      });

      expect(pagina.entries).toHaveLength(1);
      expect(pagina.entries[0].at).toContain('2026-09-15');
    });

    it('acota por categoría de actividad', async () => {
      await registrar({
        action: AUDIT_ACTIONS.PARTICIPANT_PHONE_CHANGED,
        createdAt: new Date('2026-09-01T10:00:00.000Z'),
      });
      await registrar({
        action: AUDIT_ACTIONS.SHIFT_GENERATED,
        createdAt: new Date('2026-09-01T11:00:00.000Z'),
      });

      const padron = await consulta({ categoria: 'padron' });
      expect(padron.entries).toHaveLength(1);
      expect(padron.entries[0].action).toBe(AUDIT_ACTIONS.PARTICIPANT_PHONE_CHANGED);

      const turnos = await consulta({ categoria: 'turnos' });
      expect(turnos.entries).toHaveLength(1);
      expect(turnos.entries[0].action).toBe(AUDIT_ACTIONS.SHIFT_GENERATED);
    });

    it('encuentra a una persona en las tres formas en que aparece', async () => {
      const location = await createLocation(ctx.prisma);
      const ana = await createParticipant(ctx.prisma, location.id, 'Ana López');

      // 1) como quien hizo algo
      await registrar({
        action: AUDIT_ACTIONS.SUPERVISOR_AVAILABLE,
        actorName: 'Ana López',
        createdAt: new Date('2026-09-01T10:00:00.000Z'),
      });
      // 2) como la entidad a la que le pasó algo
      await registrar({
        action: AUDIT_ACTIONS.PARTICIPANT_UPDATED,
        actorName: 'Elena Mora',
        entity: 'Participant',
        entityId: ana.id,
        createdAt: new Date('2026-09-01T11:00:00.000Z'),
      });
      // 3) dentro de metadata, cuando la entidad es la asignación
      await registrar({
        action: AUDIT_ACTIONS.ASSIGNMENT_CANCELLED,
        actorName: 'Elena Mora',
        entity: 'Assignment',
        metadata: { participantName: 'Ana López' },
        createdAt: new Date('2026-09-01T12:00:00.000Z'),
      });
      // ajena, para comprobar que no se cuela
      await registrar({
        action: AUDIT_ACTIONS.ASSIGNMENT_CANCELLED,
        actorName: 'Beto Ruiz',
        metadata: { participantName: 'Beto Ruiz' },
        createdAt: new Date('2026-09-01T13:00:00.000Z'),
      });

      const pagina = await consulta({ persona: 'Ana López' });
      expect(pagina.entries).toHaveLength(3);
    });

    it('da igual el orden de nombre y apellido', async () => {
      await registrar({
        action: AUDIT_ACTIONS.SUPERVISOR_AVAILABLE,
        actorName: 'Ana López',
        createdAt: new Date('2026-09-01T10:00:00.000Z'),
      });

      expect((await consulta({ persona: 'lópez ana' })).entries).toHaveLength(1);
      expect((await consulta({ persona: 'ANA' })).entries).toHaveLength(1);
      expect((await consulta({ persona: 'Carla' })).entries).toHaveLength(0);
    });

    it('combina los tres filtros', async () => {
      await registrar({
        action: AUDIT_ACTIONS.PARTICIPANT_UPDATED,
        actorName: 'Ana López',
        createdAt: new Date('2026-09-10T10:00:00.000Z'),
      });
      await registrar({
        action: AUDIT_ACTIONS.PARTICIPANT_UPDATED,
        actorName: 'Ana López',
        createdAt: new Date('2026-07-10T10:00:00.000Z'),
      });
      await registrar({
        action: AUDIT_ACTIONS.SHIFT_GENERATED,
        actorName: 'Ana López',
        createdAt: new Date('2026-09-11T10:00:00.000Z'),
      });

      const pagina = await consulta({
        from: new Date('2026-09-01T00:00:00.000Z'),
        categoria: 'padron',
        persona: 'Ana',
      });

      expect(pagina.entries).toHaveLength(1);
      expect(pagina.entries[0].at).toContain('2026-09-10');
    });
  });

  describe('qué ve cada rol', () => {
    beforeEach(async () => {
      await registrar({
        action: AUDIT_ACTIONS.ADMIN_LOGIN,
        createdAt: new Date('2026-09-01T10:00:00.000Z'),
      });
      await registrar({
        action: AUDIT_ACTIONS.ADMIN_LOGIN_FAILED,
        createdAt: new Date('2026-09-01T10:01:00.000Z'),
      });
      await registrar({
        action: AUDIT_ACTIONS.ADMIN_PASSWORD_RESET,
        createdAt: new Date('2026-09-01T10:02:00.000Z'),
      });
      await registrar({
        action: AUDIT_ACTIONS.SHIFT_GENERATED,
        createdAt: new Date('2026-09-01T10:03:00.000Z'),
      });
    });

    it('el administrador ve también los accesos y las cuentas', async () => {
      const pagina = await reports.auditHistory({ limit: 50, verSensibles: true });
      expect(pagina.entries).toHaveLength(4);
    });

    it('al encargado se le ocultan, incluso si pide esa categoría', async () => {
      const todo = await reports.auditHistory({ limit: 50, verSensibles: false });
      expect(todo.entries).toHaveLength(1);
      expect(todo.entries[0].action).toBe(AUDIT_ACTIONS.SHIFT_GENERATED);

      const forzado = await reports.auditHistory({
        limit: 50,
        verSensibles: false,
        categoria: 'cuentas',
      });
      expect(forzado.entries).toEqual([]);
    });
  });

  describe('lo que se muestra de cada entrada', () => {
    it('nunca deja una clave técnica a la vista', async () => {
      await registrar({
        action: AUDIT_ACTIONS.PARTICIPANT_PHONE_CHANGED,
        createdAt: new Date('2026-09-01T10:00:00.000Z'),
      });

      const [entrada] = (await consulta()).entries;

      expect(entrada.label).toBe('Cambio de teléfono');
      expect(entrada.description).toBe('Cambio de teléfono');
      expect(entrada.category).toBe('padron');
      expect(entrada.by).toBe('Elena Mora');
    });

    it('conserva la frase contextual de los movimientos de turno', async () => {
      await registrar({
        action: AUDIT_ACTIONS.ASSIGNMENT_CANCELLED,
        createdAt: new Date('2026-09-01T10:00:00.000Z'),
        metadata: { participantName: 'Ana López', shiftLabel: 'domingo 30, 7:00 a 9:00' },
      });

      const [entrada] = (await consulta()).entries;

      expect(entrada.label).toBe('Cancelación de turno');
      expect(entrada.description).toContain('Ana López');
      expect(entrada.description).toContain('domingo 30');
      expect(entrada.participantName).toBe('Ana López');
    });

    it('atribuye al sistema lo que hizo el sistema', async () => {
      await registrar({
        action: AUDIT_ACTIONS.TASK_AUTO_RESOLVED,
        actorType: ActorType.SYSTEM,
        actorName: null,
        createdAt: new Date('2026-09-01T10:00:00.000Z'),
      });

      const [entrada] = (await consulta()).entries;

      expect(entrada.by).toBe('el sistema');
      expect(entrada.actorType).toBe('SYSTEM');
    });
  });
});
