import { AssignmentStatus, CoverageOfferStatus, CoverageRequestStatus, ShiftStatus } from '@prisma/client';
import {
  createLocation,
  createParticipant,
  createShift,
  TZ,
} from '../../test/helpers/fixtures';
import { createTestContext, resetDatabase, TestContext } from '../../test/helpers/test-context';
import { DOMAIN_EVENTS } from '../events/domain-events';
import { AssignmentsService } from './assignments.service';
import { CoverageService, CoverageUnavailableError } from './coverage.service';
import { ScheduleGeneratorService } from './schedule-generator.service';
import { ShiftsService } from './shifts.service';

/** Reloj fijo: martes 25 de agosto de 2026, 12:00 hora del centro de México. */
const NOW = new Date('2026-08-25T18:00:00.000Z');

describe('Motor de turnos (integración)', () => {
  let ctx: TestContext;
  let assignments: AssignmentsService;
  let coverage: CoverageService;
  let shifts: ShiftsService;
  let generator: ScheduleGeneratorService;

  beforeAll(async () => {
    ctx = await createTestContext();
    assignments = ctx.module.get(AssignmentsService);
    coverage = ctx.module.get(CoverageService);
    shifts = ctx.module.get(ShiftsService);
    generator = ctx.module.get(ScheduleGeneratorService);
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    ctx.time.setClock(() => NOW);
  });

  describe('generación del calendario', () => {
    it('crea los turnos de lunes a viernes de todas las semanas del mes', async () => {
      const location = await createLocation(ctx.prisma);
      await ctx.prisma.shiftTemplate.create({
        data: {
          locationId: location.id,
          weekday: 3, // miércoles
          startMinute: 7 * 60,
          endMinute: 9 * 60,
          capacity: 3,
          weekOfMonth: 0, // todas las semanas
        },
      });

      const result = await generator.generateMonth(location.id, 2026, 9);

      // Septiembre de 2026 tiene cinco miércoles: 2, 9, 16, 23 y 30.
      expect(result.shiftsCreated).toBe(5);
      const created = await ctx.prisma.shift.findMany({ orderBy: { startsAt: 'asc' } });
      expect(created.map((shift) => shift.date.toISOString().slice(0, 10))).toEqual([
        '2026-09-02',
        '2026-09-09',
        '2026-09-16',
        '2026-09-23',
        '2026-09-30',
      ]);
    });

    it('crea el turno del 5.º sábado solo en los meses que lo tienen', async () => {
      const location = await createLocation(ctx.prisma);
      await ctx.prisma.shiftTemplate.create({
        data: {
          locationId: location.id,
          weekday: 6,
          startMinute: 7 * 60,
          endMinute: 9 * 60,
          capacity: 3,
          weekOfMonth: 5,
          autoFillOnly: false,
        },
      });

      // Agosto de 2026 tiene cinco sábados (el 29); septiembre solo cuatro.
      const agosto = await generator.generateMonth(location.id, 2026, 8);
      const septiembre = await generator.generateMonth(location.id, 2026, 9);

      expect(agosto.shiftsCreated).toBe(1);
      expect(septiembre.shiftsCreated).toBe(0);

      const shift = await ctx.prisma.shift.findFirstOrThrow();
      expect(shift.date.toISOString().slice(0, 10)).toBe('2026-08-29');
      expect(shift.weekOfMonth).toBe(5);
    });

    it('sienta a los titulares fijos y marca el turno como lleno', async () => {
      const location = await createLocation(ctx.prisma);
      const template = await ctx.prisma.shiftTemplate.create({
        data: {
          locationId: location.id,
          weekday: 1,
          startMinute: 7 * 60,
          endMinute: 9 * 60,
          capacity: 2,
          weekOfMonth: 0,
        },
      });
      const ana = await createParticipant(ctx.prisma, location.id, 'Ana');
      const beto = await createParticipant(ctx.prisma, location.id, 'Beto');
      await ctx.prisma.recurringAssignment.createMany({
        data: [
          { shiftTemplateId: template.id, participantId: ana.id },
          { shiftTemplateId: template.id, participantId: beto.id },
        ],
      });

      const result = await generator.generateMonth(location.id, 2026, 9);

      expect(result.assignmentsCreated).toBe(result.shiftsCreated * 2);
      const shift = await ctx.prisma.shift.findFirstOrThrow({ orderBy: { startsAt: 'asc' } });
      expect(shift.status).toBe(ShiftStatus.FULL);
    });

    it('no duplica turnos ni pisa cambios al volver a generar el mismo mes', async () => {
      const location = await createLocation(ctx.prisma);
      await ctx.prisma.shiftTemplate.create({
        data: {
          locationId: location.id,
          weekday: 1,
          startMinute: 7 * 60,
          endMinute: 9 * 60,
          capacity: 3,
          weekOfMonth: 0,
        },
      });

      const primera = await generator.generateMonth(location.id, 2026, 9);
      const segunda = await generator.generateMonth(location.id, 2026, 9);

      expect(segunda.shiftsCreated).toBe(0);
      expect(segunda.shiftsExisting).toBe(primera.shiftsCreated);
      expect(await ctx.prisma.shift.count()).toBe(primera.shiftsCreated);
    });

    it('respeta el cupo cuando hay más titulares fijos que lugares', async () => {
      const location = await createLocation(ctx.prisma);
      const template = await ctx.prisma.shiftTemplate.create({
        data: {
          locationId: location.id,
          weekday: 1,
          startMinute: 7 * 60,
          endMinute: 9 * 60,
          capacity: 2,
          weekOfMonth: 0,
        },
      });
      for (const nombre of ['Ana', 'Beto', 'Carla']) {
        const participant = await createParticipant(ctx.prisma, location.id, nombre);
        await ctx.prisma.recurringAssignment.create({
          data: { shiftTemplateId: template.id, participantId: participant.id },
        });
      }

      const result = await generator.generateMonth(location.id, 2026, 9);

      expect(result.overbookedTemplates).toContain(template.id);
      const shift = await ctx.prisma.shift.findFirstOrThrow({ orderBy: { startsAt: 'asc' } });
      expect(await shifts.countOccupied(shift.id)).toBe(2);
    });
  });

  describe('cancelación', () => {
    it('libera el lugar de inmediato y abre la vacante, sin esperar a nadie', async () => {
      const location = await createLocation(ctx.prisma);
      const ana = await createParticipant(ctx.prisma, location.id, 'Ana');
      const beto = await createParticipant(ctx.prisma, location.id, 'Beto');
      const carla = await createParticipant(ctx.prisma, location.id, 'Carla');
      const shift = await createShift(ctx.prisma, location.id, {
        startsAt: new Date('2026-08-30T13:00:00.000Z'),
        participantIds: [ana.id, beto.id, carla.id],
      });
      const assignment = await ctx.prisma.assignment.findFirstOrThrow({
        where: { shiftId: shift.id, participantId: ana.id },
      });

      await assignments.cancel({ assignmentId: assignment.id });

      const updated = await ctx.prisma.assignment.findUniqueOrThrow({
        where: { id: assignment.id },
      });
      expect(updated.status).toBe(AssignmentStatus.CANCELLED);
      expect(updated.cancelledAt).not.toBeNull();

      const request = await ctx.prisma.coverageRequest.findFirstOrThrow({
        where: { shiftId: shift.id },
      });
      expect(request.status).toBe(CoverageRequestStatus.OPEN);
      expect(request.slotsNeeded).toBe(1);
      expect((await ctx.prisma.shift.findUniqueOrThrow({ where: { id: shift.id } })).status).toBe(
        ShiftStatus.OPEN,
      );
    });

    it('marca la vacante como urgente cuando el turno es inminente', async () => {
      const location = await createLocation(ctx.prisma, { settings: { urgentWindowHours: 24 } });
      const ana = await createParticipant(ctx.prisma, location.id, 'Ana');
      const beto = await createParticipant(ctx.prisma, location.id, 'Beto');
      // Faltan seis horas para el turno.
      const shift = await createShift(ctx.prisma, location.id, {
        startsAt: new Date('2026-08-26T00:00:00.000Z'),
        participantIds: [ana.id, beto.id],
      });
      const assignment = await ctx.prisma.assignment.findFirstOrThrow({
        where: { shiftId: shift.id, participantId: ana.id },
      });

      await assignments.cancel({ assignmentId: assignment.id });

      const request = await ctx.prisma.coverageRequest.findFirstOrThrow();
      expect(request.urgent).toBe(true);
    });

    it('avisa cuando el turno queda con un solo participante', async () => {
      const location = await createLocation(ctx.prisma, { minCapacity: 2 });
      const ana = await createParticipant(ctx.prisma, location.id, 'Ana');
      const beto = await createParticipant(ctx.prisma, location.id, 'Beto');
      const shift = await createShift(ctx.prisma, location.id, {
        startsAt: new Date('2026-08-30T13:00:00.000Z'),
        participantIds: [ana.id, beto.id],
      });
      const assignment = await ctx.prisma.assignment.findFirstOrThrow({
        where: { shiftId: shift.id, participantId: ana.id },
      });

      const lowStaff = jest.fn();
      ctx.events.on(DOMAIN_EVENTS.SHIFT_LOW_STAFF, lowStaff);

      await assignments.cancel({ assignmentId: assignment.id });

      expect(lowStaff).toHaveBeenCalledTimes(1);
      expect(lowStaff.mock.calls[0][0]).toMatchObject({
        remaining: 1,
        minCapacity: 2,
        remainingParticipantNames: ['Beto'],
      });
      ctx.events.off(DOMAIN_EVENTS.SHIFT_LOW_STAFF, lowStaff);
    });

    it('rechaza cancelar dos veces el mismo turno', async () => {
      const location = await createLocation(ctx.prisma);
      const ana = await createParticipant(ctx.prisma, location.id, 'Ana');
      const shift = await createShift(ctx.prisma, location.id, {
        startsAt: new Date('2026-08-30T13:00:00.000Z'),
        participantIds: [ana.id],
      });
      const assignment = await ctx.prisma.assignment.findFirstOrThrow({
        where: { shiftId: shift.id },
      });

      await assignments.cancel({ assignmentId: assignment.id });
      await expect(assignments.cancel({ assignmentId: assignment.id })).rejects.toThrow(
        /ya estaba cancelado/,
      );
    });

    it('rechaza cancelar un turno que ya pasó', async () => {
      const location = await createLocation(ctx.prisma);
      const ana = await createParticipant(ctx.prisma, location.id, 'Ana');
      const shift = await createShift(ctx.prisma, location.id, {
        startsAt: new Date('2026-08-20T13:00:00.000Z'),
        participantIds: [ana.id],
      });
      const assignment = await ctx.prisma.assignment.findFirstOrThrow({
        where: { shiftId: shift.id },
      });

      await expect(assignments.cancel({ assignmentId: assignment.id })).rejects.toThrow(/ya pasó/);
    });
  });

  describe('coberturas', () => {
    async function escenarioConVacante() {
      const location = await createLocation(ctx.prisma);
      const ana = await createParticipant(ctx.prisma, location.id, 'Ana');
      const beto = await createParticipant(ctx.prisma, location.id, 'Beto');
      const carla = await createParticipant(ctx.prisma, location.id, 'Carla');
      const dora = await createParticipant(ctx.prisma, location.id, 'Dora');
      const encargado = await createParticipant(ctx.prisma, location.id, 'Elena');
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
      return { location, shift, request, ana, beto, carla, dora, encargado };
    }

    it('registra el ofrecimiento sin asignar el lugar todavía', async () => {
      const { request, dora, shift } = await escenarioConVacante();

      await coverage.offer(request.id, dora.id);

      const offer = await ctx.prisma.coverageOffer.findFirstOrThrow();
      expect(offer.status).toBe(CoverageOfferStatus.PENDING);
      // Hasta que un encargado apruebe, el lugar sigue libre.
      expect(await shifts.countOccupied(shift.id)).toBe(2);
    });

    it('impide ofrecerse a un turno en el que ya se tiene lugar', async () => {
      const { request, beto } = await escenarioConVacante();
      await expect(coverage.offer(request.id, beto.id)).rejects.toThrow(/Ya tienes lugar/);
    });

    it('asigna el lugar al aprobar y agradece a quien no fue elegido', async () => {
      const { request, dora, ana, encargado, shift } = await escenarioConVacante();

      await coverage.offer(request.id, dora.id);
      const segundoOfrecimiento = await coverage.offer(request.id, ana.id);
      const primerOfrecimiento = await ctx.prisma.coverageOffer.findFirstOrThrow({
        where: { participantId: dora.id },
      });

      const fulfilled = jest.fn();
      ctx.events.on(DOMAIN_EVENTS.COVERAGE_FULFILLED, fulfilled);

      await coverage.approve(primerOfrecimiento.id, encargado.id);

      expect(await shifts.countOccupied(shift.id)).toBe(3);
      const aprobado = await ctx.prisma.coverageOffer.findUniqueOrThrow({
        where: { id: primerOfrecimiento.id },
      });
      expect(aprobado.status).toBe(CoverageOfferStatus.APPROVED);
      expect(aprobado.decidedById).toBe(encargado.id);

      const noElegido = await ctx.prisma.coverageOffer.findUniqueOrThrow({
        where: { id: segundoOfrecimiento },
      });
      expect(noElegido.status).toBe(CoverageOfferStatus.DECLINED);

      expect(fulfilled).toHaveBeenCalledTimes(1);
      expect(fulfilled.mock.calls[0][0].notSelectedParticipantIds).toEqual([ana.id]);
      ctx.events.off(DOMAIN_EVENTS.COVERAGE_FULFILLED, fulfilled);

      const request2 = await ctx.prisma.coverageRequest.findUniqueOrThrow({
        where: { id: request.id },
      });
      expect(request2.status).toBe(CoverageRequestStatus.FULFILLED);
    });

    it('con dos aprobaciones simultáneas para un solo lugar, gana una y la otra falla', async () => {
      const { request, dora, ana, encargado, shift } = await escenarioConVacante();

      const ofertaDora = await coverage.offer(request.id, dora.id);
      const ofertaAna = await coverage.offer(request.id, ana.id);

      const resultados = await Promise.allSettled([
        coverage.approve(ofertaDora, encargado.id),
        coverage.approve(ofertaAna, encargado.id),
      ]);

      const exitosas = resultados.filter((r) => r.status === 'fulfilled');
      const fallidas = resultados.filter((r) => r.status === 'rejected');
      expect(exitosas).toHaveLength(1);
      expect(fallidas).toHaveLength(1);

      // Lo esencial: nunca se excede el cupo del turno.
      expect(await shifts.countOccupied(shift.id)).toBe(3);
    });

    it('no acepta ofrecimientos después del plazo de cierre', async () => {
      const { request, dora } = await escenarioConVacante();
      await ctx.prisma.coverageRequest.update({
        where: { id: request.id },
        data: { closesAt: new Date('2026-08-25T17:00:00.000Z') },
      });

      await expect(coverage.offer(request.id, dora.id)).rejects.toThrow(
        CoverageUnavailableError,
      );
    });

    it('cierra las vacantes vencidas y expira sus ofrecimientos', async () => {
      const { request, dora } = await escenarioConVacante();
      await coverage.offer(request.id, dora.id);
      await ctx.prisma.coverageRequest.update({
        where: { id: request.id },
        data: { closesAt: new Date('2026-08-25T17:00:00.000Z') },
      });

      const cerradas = await coverage.expireStale();

      expect(cerradas).toBe(1);
      const actualizada = await ctx.prisma.coverageRequest.findUniqueOrThrow({
        where: { id: request.id },
      });
      expect(actualizada.status).toBe(CoverageRequestStatus.EXPIRED);
      const offer = await ctx.prisma.coverageOffer.findFirstOrThrow();
      expect(offer.status).toBe(CoverageOfferStatus.EXPIRED);
    });

    it('reutiliza la vacante abierta cuando cancela una segunda persona', async () => {
      const { request, beto, shift } = await escenarioConVacante();
      const assignmentBeto = await ctx.prisma.assignment.findFirstOrThrow({
        where: { shiftId: shift.id, participantId: beto.id },
      });

      await assignments.cancel({ assignmentId: assignmentBeto.id });

      const requests = await ctx.prisma.coverageRequest.findMany({ where: { shiftId: shift.id } });
      expect(requests).toHaveLength(1);
      expect(requests[0].id).toBe(request.id);
      expect(requests[0].slotsNeeded).toBe(2);
    });

    it('deja registro en bitácora de la aprobación automática', async () => {
      const { request, dora } = await escenarioConVacante();
      const offerId = await coverage.offer(request.id, dora.id);

      await coverage.approve(offerId, null, { automatic: true });

      const log = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'coverage.auto_approved' },
      });
      expect(log.actorType).toBe('SYSTEM');
      expect((log.metadata as { automatic: boolean }).automatic).toBe(true);
    });
  });

  it('formatea la etiqueta del turno en español', async () => {
    const location = await createLocation(ctx.prisma);
    const shift = await createShift(ctx.prisma, location.id, {
      startsAt: new Date('2026-08-27T13:00:00.000Z'),
      date: new Date(Date.UTC(2026, 7, 27)),
      startMinute: 7 * 60,
      endMinute: 9 * 60,
    });
    expect(shifts.label(shift, TZ)).toBe('jueves 27 de agosto, 7:00 a 9:00');
  });
});
