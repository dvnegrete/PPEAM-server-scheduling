import { AssignmentOrigin, AssignmentStatus } from '@prisma/client';
import { createLocation, createParticipant, createShift } from '../../test/helpers/fixtures';
import { createFullTestContext, resetDatabase, TestContext } from '../../test/helpers/test-context';
import { AUDIT_ACTIONS } from '../audit/audit.service';
import { ConfirmationsDraftService } from './confirmations-draft.service';

/** Martes 25 de agosto de 2026, 12:00 hora del centro de México. */
const NOW = new Date('2026-08-25T18:00:00.000Z');

/** Sábado 29 de agosto, 09:00 local. */
const SABADO = new Date('2026-08-29T15:00:00.000Z');
/** Domingo 30 de agosto, 07:00 local. */
const DOMINGO = new Date('2026-08-30T13:00:00.000Z');

describe('Mensaje de confirmaciones para el grupo (integración)', () => {
  let ctx: TestContext;
  let confirmaciones: ConfirmationsDraftService;

  beforeAll(async () => {
    ctx = await createFullTestContext();
    confirmaciones = ctx.module.get(ConfirmationsDraftService);
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    ctx.time.setClock(() => NOW);
  });

  const encargado = { id: 'admin-1', name: 'Elena Mora' };

  /** Sienta a alguien como cobertura, que es lo que hace el panel al capturarla. */
  async function cubre(
    shiftId: string,
    participantId: string,
    status: AssignmentStatus = AssignmentStatus.ASSIGNED,
  ) {
    await ctx.prisma.assignment.create({
      data: {
        shiftId,
        participantId,
        origin: AssignmentOrigin.COVERAGE,
        status,
        assignedAt: NOW,
        assignedByName: 'Elena Mora',
      },
    });
    return `${shiftId}:${participantId}`;
  }

  describe('el borrador', () => {
    it('agrupa en una línea a quienes cubren el mismo turno, con su nombre completo', async () => {
      const location = await createLocation(ctx.prisma);
      const shift = await createShift(ctx.prisma, location.id, {
        startsAt: SABADO,
        startMinute: 9 * 60,
      });
      const martha = await createParticipant(ctx.prisma, location.id, 'Martha López Ruiz');
      const ricardo = await createParticipant(ctx.prisma, location.id, 'Ricardo Peña Soto');
      await cubre(shift.id, martha.id);
      await cubre(shift.id, ricardo.id);

      const borrador = await confirmaciones.build(location.id);

      expect(borrador.rows).toHaveLength(2);
      expect(borrador.text).toBe(
        'Confirmamos el siguiente horario:\n' +
          '- Sáb. 29 de 09:00 a 11:00 am: [Martha López Ruiz] y [Ricardo Peña Soto]',
      );
    });

    it('con dos turnos, el encabezado va en plural y cada turno en su línea', async () => {
      const location = await createLocation(ctx.prisma);
      const sabado = await createShift(ctx.prisma, location.id, {
        startsAt: SABADO,
        startMinute: 9 * 60,
      });
      const domingo = await createShift(ctx.prisma, location.id, {
        startsAt: DOMINGO,
        startMinute: 7 * 60,
      });
      const martha = await createParticipant(ctx.prisma, location.id, 'Martha López Ruiz');
      const elena = await createParticipant(ctx.prisma, location.id, 'Elena Núñez');
      await cubre(sabado.id, martha.id);
      await cubre(domingo.id, elena.id);

      const borrador = await confirmaciones.build(location.id);

      expect(borrador.text).toBe(
        'Confirmamos los siguientes horarios:\n' +
          '- Sáb. 29 de 09:00 a 11:00 am: [Martha López Ruiz]\n' +
          '- Dom. 30 de 07:00 a 09:00 am: [Elena Núñez]',
      );
    });

    it('quien tiene un solo apellido sale con ese, sin espacios de sobra', async () => {
      const location = await createLocation(ctx.prisma);
      const shift = await createShift(ctx.prisma, location.id, { startsAt: SABADO });
      const persona = await createParticipant(ctx.prisma, location.id, 'Dora Sosa');
      await cubre(shift.id, persona.id);

      const borrador = await confirmaciones.build(location.id);

      expect(borrador.rows[0].name).toBe('Dora Sosa');
      expect(borrador.text).toContain('[Dora Sosa]');
    });

    it('deja fuera los turnos que ya pasaron', async () => {
      const location = await createLocation(ctx.prisma);
      const ayer = await createShift(ctx.prisma, location.id, {
        startsAt: new Date('2026-08-24T15:00:00.000Z'),
      });
      const persona = await createParticipant(ctx.prisma, location.id, 'Ana López');
      await cubre(ayer.id, persona.id);

      const borrador = await confirmaciones.build(location.id);

      expect(borrador.rows).toHaveLength(0);
      expect(borrador.text).toBe('No hay confirmaciones pendientes de publicar.');
    });

    it('deja fuera una cobertura cancelada y a los titulares de turno fijo', async () => {
      const location = await createLocation(ctx.prisma);
      const titular = await createParticipant(ctx.prisma, location.id, 'Ana López');
      const shift = await createShift(ctx.prisma, location.id, {
        startsAt: SABADO,
        // Entra como FIXED, que es lo que hace el calendario con los turnos fijos.
        participantIds: [titular.id],
      });
      const quienCancelo = await createParticipant(ctx.prisma, location.id, 'Beto Ruiz');
      await cubre(shift.id, quienCancelo.id, AssignmentStatus.CANCELLED);

      const borrador = await confirmaciones.build(location.id);

      expect(borrador.rows).toHaveLength(0);
    });

    it('no mira más allá del horizonte pedido', async () => {
      const location = await createLocation(ctx.prisma);
      const lejano = await createShift(ctx.prisma, location.id, {
        startsAt: new Date('2026-09-20T15:00:00.000Z'),
      });
      const persona = await createParticipant(ctx.prisma, location.id, 'Ana López');
      await cubre(lejano.id, persona.id);

      expect((await confirmaciones.build(location.id)).rows).toHaveLength(0);
      expect((await confirmaciones.build(location.id, 60)).rows).toHaveLength(1);
    });

    it('no trae las coberturas de otro punto', async () => {
      const uno = await createLocation(ctx.prisma, { name: 'Punto 1' });
      const otro = await createLocation(ctx.prisma, { name: 'Punto 2' });
      const shift = await createShift(ctx.prisma, otro.id, { startsAt: SABADO });
      const persona = await createParticipant(ctx.prisma, otro.id, 'Ana López');
      await cubre(shift.id, persona.id);

      expect((await confirmaciones.build(uno.id)).rows).toHaveLength(0);
    });
  });

  describe('al declarar que ya se publicó', () => {
    async function dosCoberturas() {
      const location = await createLocation(ctx.prisma);
      const sabado = await createShift(ctx.prisma, location.id, {
        startsAt: SABADO,
        startMinute: 9 * 60,
      });
      const domingo = await createShift(ctx.prisma, location.id, {
        startsAt: DOMINGO,
        startMinute: 7 * 60,
      });
      const martha = await createParticipant(ctx.prisma, location.id, 'Martha López Ruiz');
      const elena = await createParticipant(ctx.prisma, location.id, 'Elena Núñez');
      return {
        location,
        deMartha: await cubre(sabado.id, martha.id),
        deElena: await cubre(domingo.id, elena.id),
      };
    }

    it('lo anota en la bitácora con quién lo publicó y deja de ofrecerlo', async () => {
      const { location, deMartha, deElena } = await dosCoberturas();

      const resultado = await confirmaciones.announce(location.id, [deMartha, deElena], encargado);

      expect(resultado.announced).toHaveLength(2);
      expect(resultado.alreadyAnnounced).toHaveLength(0);
      expect(resultado.draft.rows).toHaveLength(0);

      const logs = await ctx.prisma.auditLog.findMany({
        where: { action: AUDIT_ACTIONS.COVERAGE_ANNOUNCED },
      });
      expect(logs).toHaveLength(2);
      expect(logs[0].actorName).toBe('Elena Mora');
      expect(logs[0].entity).toBe('Assignment');
      expect(logs.map((log) => log.entityId).sort()).toEqual([deMartha, deElena].sort());
    });

    // Es el caso que justifica el diálogo de confirmación: el encargado publicó
    // el mensaje pero borró una línea antes de enviarlo.
    it('marcar solo una deja la otra pendiente para el mensaje siguiente', async () => {
      const { location, deMartha, deElena } = await dosCoberturas();

      const resultado = await confirmaciones.announce(location.id, [deMartha], encargado);

      expect(resultado.draft.rows.map((row) => row.key)).toEqual([deElena]);
      expect(resultado.draft.text).toContain('[Elena Núñez]');
      expect(resultado.draft.text).not.toContain('[Martha López Ruiz]');
    });

    it('si otro encargado ya la había marcado, no duplica la entrada y lo avisa', async () => {
      const { location, deMartha } = await dosCoberturas();
      await confirmaciones.announce(location.id, [deMartha], encargado);

      const segunda = await confirmaciones.announce(location.id, [deMartha], {
        id: 'admin-2',
        name: 'Felipe Cruz',
      });

      expect(segunda.announced).toHaveLength(0);
      expect(segunda.alreadyAnnounced).toEqual([deMartha]);
      const logs = await ctx.prisma.auditLog.findMany({
        where: { action: AUDIT_ACTIONS.COVERAGE_ANNOUNCED },
      });
      expect(logs).toHaveLength(1);
    });

    it('una clave repetida se anota una sola vez', async () => {
      const { location, deMartha } = await dosCoberturas();

      const resultado = await confirmaciones.announce(location.id, [deMartha, deMartha], encargado);

      expect(resultado.announced).toEqual([deMartha]);
    });

    it('rechaza una clave que no es una cobertura vigente del punto, sin anotar nada', async () => {
      const { location, deMartha } = await dosCoberturas();

      await expect(
        confirmaciones.announce(location.id, [deMartha, 'inventado:cualquiera'], encargado),
      ).rejects.toThrow(/ya no está vigente|ya no están vigentes/);

      const logs = await ctx.prisma.auditLog.findMany({
        where: { action: AUDIT_ACTIONS.COVERAGE_ANNOUNCED },
      });
      expect(logs).toHaveLength(0);
    });

    it('rechaza una clave mal formada', async () => {
      const { location } = await dosCoberturas();

      await expect(
        confirmaciones.announce(location.id, ['sin-dos-puntos'], encargado),
      ).rejects.toThrow(/Clave de confirmación inválida/);
    });

    it('rechaza la cobertura de otro punto aunque exista', async () => {
      const { deMartha } = await dosCoberturas();
      const otro = await createLocation(ctx.prisma, { name: 'Punto 2' });

      await expect(confirmaciones.announce(otro.id, [deMartha], encargado)).rejects.toThrow(
        /ya no está vigente/,
      );
    });
  });
});
