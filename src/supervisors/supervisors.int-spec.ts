import { ParticipantRole, SupervisorTaskStatus, SupervisorTaskType } from '@prisma/client';
import { createLocation, createParticipant, createShift } from '../../test/helpers/fixtures';
import { createTestContext, resetDatabase, TestContext } from '../../test/helpers/test-context';
import { AssignmentsService } from '../scheduling/assignments.service';
import { CoverageService } from '../scheduling/coverage.service';
import { ShiftsService } from '../scheduling/shifts.service';
import { SupervisorTasksScheduler } from './supervisor-tasks.scheduler';
import { SupervisorTasksService, TaskAlreadyHandledError } from './supervisor-tasks.service';
import { SupervisorsService } from './supervisors.service';
import { SupervisorsModule } from './supervisors.module';

/** Martes 25 de agosto de 2026, 12:00 en hora del centro de México. */
const NOW = new Date('2026-08-25T18:00:00.000Z');
const MARTES = 2;

describe('Encargados: guardia y cola de solicitudes (integración)', () => {
  let ctx: TestContext;
  let supervisors: SupervisorsService;
  let tasks: SupervisorTasksService;
  let scheduler: SupervisorTasksScheduler;
  let assignments: AssignmentsService;
  let coverage: CoverageService;
  let shifts: ShiftsService;

  beforeAll(async () => {
    ctx = await createTestContext([SupervisorsModule]);
    supervisors = ctx.module.get(SupervisorsService);
    tasks = ctx.module.get(SupervisorTasksService);
    scheduler = ctx.module.get(SupervisorTasksScheduler);
    assignments = ctx.module.get(AssignmentsService);
    coverage = ctx.module.get(CoverageService);
    shifts = ctx.module.get(ShiftsService);
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    ctx.time.setClock(() => NOW);
  });

  async function crearEncargado(locationId: string, nombre: string) {
    return createParticipant(ctx.prisma, locationId, nombre, ParticipantRole.SUPERVISOR);
  }

  describe('quién está de guardia', () => {
    it('incluye a quien tiene una franja fija vigente', async () => {
      const location = await createLocation(ctx.prisma);
      const elena = await crearEncargado(location.id, 'Elena');
      // Martes de 8:00 a 14:00; son las 12:00.
      await supervisors.addWindow(elena.id, location.id, MARTES, 8 * 60, 14 * 60);

      const onDuty = await supervisors.onDutyNow(location.id);
      expect(onDuty.map((p) => p.id)).toEqual([elena.id]);
    });

    it('excluye a quien está fuera de su franja', async () => {
      const location = await createLocation(ctx.prisma);
      const elena = await crearEncargado(location.id, 'Elena');
      await supervisors.addWindow(elena.id, location.id, MARTES, 15 * 60, 18 * 60);

      expect(await supervisors.onDutyNow(location.id)).toHaveLength(0);
    });

    it('la declaración manual gana sobre el horario habitual', async () => {
      const location = await createLocation(ctx.prisma);
      const elena = await crearEncargado(location.id, 'Elena');
      const felipe = await crearEncargado(location.id, 'Felipe');
      // Elena está en su franja pero avisa que ahora no puede.
      await supervisors.addWindow(elena.id, location.id, MARTES, 8 * 60, 14 * 60);
      await supervisors.setUnavailable(elena.id);
      // Felipe no tiene franja hoy, pero se conecta.
      await supervisors.setAvailable(felipe.id);

      const onDuty = await supervisors.onDutyNow(location.id);
      expect(onDuty.map((p) => p.id)).toEqual([felipe.id]);
    });

    it('al expirar la declaración manual vuelve a regir la franja fija', async () => {
      const location = await createLocation(ctx.prisma);
      const elena = await crearEncargado(location.id, 'Elena');
      await supervisors.addWindow(elena.id, location.id, MARTES, 8 * 60, 14 * 60);
      // Dijo "no disponible" hasta las 11:00, y ya son las 12:00.
      await supervisors.setUnavailable(elena.id, new Date('2026-08-25T17:00:00.000Z'));

      const onDuty = await supervisors.onDutyNow(location.id);
      expect(onDuty.map((p) => p.id)).toEqual([elena.id]);
    });

    it('no considera de guardia a un participante que no es encargado', async () => {
      const location = await createLocation(ctx.prisma);
      const ana = await createParticipant(ctx.prisma, location.id, 'Ana');
      await supervisors.addWindow(ana.id, location.id, MARTES, 8 * 60, 14 * 60);

      expect(await supervisors.onDutyNow(location.id)).toHaveLength(0);
      expect(await supervisors.isSupervisor(ana.id, location.id)).toBe(false);
    });

    it('informa su estado de guardia al propio encargado', async () => {
      const location = await createLocation(ctx.prisma);
      const elena = await crearEncargado(location.id, 'Elena');
      await supervisors.addWindow(elena.id, location.id, MARTES, 8 * 60, 14 * 60);

      const status = await supervisors.dutyStatus(elena.id, location.id);
      expect(status.onDuty).toBe(true);
      expect(status.overrideActive).toBe(false);
      expect(status.windows).toHaveLength(1);
    });
  });

  describe('reparto exclusivo de solicitudes', () => {
    it('el primero que la toma la bloquea y el segundo recibe un aviso claro', async () => {
      const location = await createLocation(ctx.prisma);
      const elena = await crearEncargado(location.id, 'Elena');
      const felipe = await crearEncargado(location.id, 'Felipe');
      const task = await tasks.create({
        locationId: location.id,
        type: SupervisorTaskType.QUESTION,
        payload: { question: '¿Dónde se guarda el exhibidor?' },
      });

      await tasks.claim(task.id, elena.id);
      await expect(tasks.claim(task.id, felipe.id)).rejects.toThrow(TaskAlreadyHandledError);

      const claimed = await tasks.findById(task.id);
      expect(claimed?.status).toBe(SupervisorTaskStatus.CLAIMED);
      expect(claimed?.claimedById).toBe(elena.id);
    });

    it('quien ya la reclamó puede seguir trabajando en ella', async () => {
      const location = await createLocation(ctx.prisma);
      const elena = await crearEncargado(location.id, 'Elena');
      const task = await tasks.create({
        locationId: location.id,
        type: SupervisorTaskType.QUESTION,
        payload: {},
      });

      await tasks.claim(task.id, elena.id);
      await expect(tasks.claim(task.id, elena.id)).resolves.toBeDefined();
    });

    it('usa el plazo corto para las solicitudes urgentes', async () => {
      const location = await createLocation(ctx.prisma, {
        settings: { supervisorTimeoutMinutes: 60, urgentSupervisorTimeoutMinutes: 30 },
      });
      const normal = await tasks.create({
        locationId: location.id,
        type: SupervisorTaskType.QUESTION,
        payload: {},
      });
      const urgente = await tasks.create({
        locationId: location.id,
        type: SupervisorTaskType.COVERAGE_APPROVAL,
        payload: {},
        urgent: true,
      });

      expect(normal.dueAt.getTime() - NOW.getTime()).toBe(60 * 60_000);
      expect(urgente.dueAt.getTime() - NOW.getTime()).toBe(30 * 60_000);
    });
  });

  describe('cuando nadie de guardia responde a tiempo', () => {
    async function escenarioVacanteUrgente() {
      const location = await createLocation(ctx.prisma, {
        settings: { urgentWindowHours: 24, urgentSupervisorTimeoutMinutes: 30 },
      });
      const ana = await createParticipant(ctx.prisma, location.id, 'Ana');
      const beto = await createParticipant(ctx.prisma, location.id, 'Beto');
      const carla = await createParticipant(ctx.prisma, location.id, 'Carla');
      const dora = await createParticipant(ctx.prisma, location.id, 'Dora');
      // El turno es en seis horas: cae dentro de la ventana de urgencia.
      const shift = await createShift(ctx.prisma, location.id, {
        startsAt: new Date('2026-08-26T00:00:00.000Z'),
        capacity: 3,
        participantIds: [ana.id, beto.id, carla.id],
      });
      const assignment = await ctx.prisma.assignment.findFirstOrThrow({
        where: { shiftId: shift.id, participantId: ana.id },
      });
      await assignments.cancel({ assignmentId: assignment.id });
      const request = await ctx.prisma.coverageRequest.findFirstOrThrow();
      return { location, shift, request, dora, ana };
    }

    it('aprueba automáticamente al primero que se ofreció', async () => {
      const { request, dora, ana, shift } = await escenarioVacanteUrgente();

      await coverage.offer(request.id, dora.id);
      await coverage.offer(request.id, ana.id);

      const task = await ctx.prisma.supervisorTask.findFirstOrThrow({
        where: { type: SupervisorTaskType.COVERAGE_APPROVAL },
      });
      expect(task.urgent).toBe(true);

      // Pasan 31 minutos sin que ningún encargado responda.
      ctx.time.setClock(() => new Date(NOW.getTime() + 31 * 60_000));
      await scheduler.processDueTasks();

      expect(await shifts.countOccupied(shift.id)).toBe(3);
      const asignada = await ctx.prisma.assignment.findFirstOrThrow({
        where: { shiftId: shift.id, participantId: dora.id },
      });
      expect(asignada.origin).toBe('COVERAGE');

      const resuelta = await ctx.prisma.supervisorTask.findUniqueOrThrow({
        where: { id: task.id },
      });
      expect(resuelta.status).toBe(SupervisorTaskStatus.AUTO_RESOLVED);
      expect(resuelta.resolution).toContain('Dora');
    });

    it('deja constancia en bitácora de que la resolvió el sistema', async () => {
      const { request, dora } = await escenarioVacanteUrgente();
      await coverage.offer(request.id, dora.id);

      ctx.time.setClock(() => new Date(NOW.getTime() + 31 * 60_000));
      await scheduler.processDueTasks();

      const log = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'task.auto_resolved' },
      });
      expect(log.actorType).toBe('SYSTEM');
    });

    it('si es urgente pero nadie se ofreció, insiste en vez de inventar una solución', async () => {
      await escenarioVacanteUrgente();
      const task = await ctx.prisma.supervisorTask.findFirstOrThrow({
        where: { type: SupervisorTaskType.CANCELLATION_NOTICE },
      });

      ctx.time.setClock(() => new Date(NOW.getTime() + 31 * 60_000));
      await scheduler.processDueTasks();

      // El aviso informativo se cierra solo; no hay nada que decidir.
      const cerrada = await ctx.prisma.supervisorTask.findUniqueOrThrow({ where: { id: task.id } });
      expect(cerrada.status).toBe(SupervisorTaskStatus.AUTO_RESOLVED);
    });

    it('nunca cancela solo un turno con poco personal: escala', async () => {
      const location = await createLocation(ctx.prisma, { minCapacity: 2 });
      const ana = await createParticipant(ctx.prisma, location.id, 'Ana');
      const beto = await createParticipant(ctx.prisma, location.id, 'Beto');
      const shift = await createShift(ctx.prisma, location.id, {
        startsAt: new Date('2026-08-26T00:00:00.000Z'),
        capacity: 3,
        participantIds: [ana.id, beto.id],
      });
      const assignment = await ctx.prisma.assignment.findFirstOrThrow({
        where: { shiftId: shift.id, participantId: ana.id },
      });
      await assignments.cancel({ assignmentId: assignment.id });

      const alerta = await ctx.prisma.supervisorTask.findFirstOrThrow({
        where: { type: SupervisorTaskType.LOW_STAFF_ALERT },
      });

      ctx.time.setClock(() => new Date(NOW.getTime() + 120 * 60_000));
      await scheduler.processDueTasks();

      const despues = await ctx.prisma.supervisorTask.findUniqueOrThrow({
        where: { id: alerta.id },
      });
      expect(despues.status).toBe(SupervisorTaskStatus.PENDING);
      expect(despues.notifiedCount).toBe(1);
      expect(despues.dueAt.getTime()).toBeGreaterThan(alerta.dueAt.getTime());

      const turno = await ctx.prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
      expect(turno.status).not.toBe('CANCELLED');
    });
  });

  describe('tareas generadas por el motor de turnos', () => {
    it('acumula los ofrecimientos en una sola solicitud de aprobación', async () => {
      const location = await createLocation(ctx.prisma);
      const ana = await createParticipant(ctx.prisma, location.id, 'Ana');
      const beto = await createParticipant(ctx.prisma, location.id, 'Beto');
      const carla = await createParticipant(ctx.prisma, location.id, 'Carla');
      const dora = await createParticipant(ctx.prisma, location.id, 'Dora');
      const shift = await createShift(ctx.prisma, location.id, {
        startsAt: new Date('2026-08-30T13:00:00.000Z'),
        capacity: 3,
        participantIds: [ana.id, beto.id, carla.id],
      });
      const assignment = await ctx.prisma.assignment.findFirstOrThrow({
        where: { shiftId: shift.id, participantId: ana.id },
      });
      await assignments.cancel({ assignmentId: assignment.id });
      const request = await ctx.prisma.coverageRequest.findFirstOrThrow();

      await coverage.offer(request.id, dora.id);
      await coverage.offer(request.id, ana.id);

      const aprobaciones = await ctx.prisma.supervisorTask.findMany({
        where: { type: SupervisorTaskType.COVERAGE_APPROVAL },
      });
      expect(aprobaciones).toHaveLength(1);
      const payload = aprobaciones[0].payload as { offers: unknown[] };
      expect(payload.offers).toHaveLength(2);
    });

    it('cierra la solicitud de aprobación cuando la vacante se cubre', async () => {
      const location = await createLocation(ctx.prisma);
      const ana = await createParticipant(ctx.prisma, location.id, 'Ana');
      const beto = await createParticipant(ctx.prisma, location.id, 'Beto');
      const carla = await createParticipant(ctx.prisma, location.id, 'Carla');
      const dora = await createParticipant(ctx.prisma, location.id, 'Dora');
      const elena = await crearEncargado(location.id, 'Elena');
      const shift = await createShift(ctx.prisma, location.id, {
        startsAt: new Date('2026-08-30T13:00:00.000Z'),
        capacity: 3,
        participantIds: [ana.id, beto.id, carla.id],
      });
      const assignment = await ctx.prisma.assignment.findFirstOrThrow({
        where: { shiftId: shift.id, participantId: ana.id },
      });
      await assignments.cancel({ assignmentId: assignment.id });
      const request = await ctx.prisma.coverageRequest.findFirstOrThrow();
      const offerId = await coverage.offer(request.id, dora.id);

      await coverage.approve(offerId, elena.id);

      const aprobacion = await ctx.prisma.supervisorTask.findFirstOrThrow({
        where: { type: SupervisorTaskType.COVERAGE_APPROVAL },
      });
      expect(aprobacion.status).toBe(SupervisorTaskStatus.CANCELLED);
    });
  });
});
