import { ParticipantRole } from '@prisma/client';
import { createParticipant, createShift } from '../../test/helpers/fixtures';
import { createFullTestContext, resetDatabase, TestContext } from '../../test/helpers/test-context';
import { NotificationService } from '../messaging/notification.service';
import { CoverageService } from '../scheduling/coverage.service';
import { SupervisorsService } from '../supervisors/supervisors.service';
import { MessageBuilder } from '../whatsapp/message-builder';
import { MembershipsService } from './memberships.service';

/** Martes 25 de agosto de 2026, 12:00 hora del centro de México. */
const NOW = new Date('2026-08-25T18:00:00.000Z');
const MARTES = 2;

describe('Participantes en varios puntos de exhibición (integración)', () => {
  let ctx: TestContext;
  let membresias: MembershipsService;
  let supervisores: SupervisorsService;
  let notificaciones: NotificationService;
  let coberturas: CoverageService;

  beforeAll(async () => {
    ctx = await createFullTestContext();
    membresias = ctx.module.get(MembershipsService);
    supervisores = ctx.module.get(SupervisorsService);
    notificaciones = ctx.module.get(NotificationService);
    coberturas = ctx.module.get(CoverageService);
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    ctx.time.setClock(() => NOW);
  });

  /** Dos puntos, para poder probar de verdad la relación muchos a muchos. */
  async function dosPuntos() {
    const norte = await ctx.prisma.location.create({
      data: {
        name: 'Punto Norte',
        timezone: 'America/Mexico_City',
        settings: { messagingMode: 'live', broadcastCoverageToParticipants: true },
      },
    });
    const sur = await ctx.prisma.location.create({
      data: {
        name: 'Punto Sur',
        timezone: 'America/Mexico_City',
        settings: { messagingMode: 'live', broadcastCoverageToParticipants: true },
      },
    });
    return { norte, sur };
  }

  describe('el rol depende del punto', () => {
    it('la misma persona es encargada en uno y solo participante en otro', async () => {
      const { norte, sur } = await dosPuntos();
      const elena = await createParticipant(ctx.prisma, norte.id, 'Elena Mora');

      await membresias.setRole(elena.id, norte.id, ParticipantRole.SUPERVISOR);
      await membresias.join(elena.id, sur.id, { role: ParticipantRole.PARTICIPANT });

      expect(await supervisores.isSupervisor(elena.id, norte.id)).toBe(true);
      expect(await supervisores.isSupervisor(elena.id, sur.id)).toBe(false);
    });

    it('solo está de guardia en el punto donde es encargada', async () => {
      const { norte, sur } = await dosPuntos();
      const elena = await createParticipant(ctx.prisma, norte.id, 'Elena Mora');
      await membresias.setRole(elena.id, norte.id, ParticipantRole.SUPERVISOR);
      await membresias.join(elena.id, sur.id, { role: ParticipantRole.PARTICIPANT });

      // Franjas de guardia en ambos puntos: lo que la excluye del sur es el rol.
      await supervisores.addWindow(elena.id, norte.id, MARTES, 8 * 60, 14 * 60);
      await supervisores.addWindow(elena.id, sur.id, MARTES, 8 * 60, 14 * 60);

      expect((await supervisores.onDutyNow(norte.id)).map((p) => p.id)).toEqual([elena.id]);
      expect(await supervisores.onDutyNow(sur.id)).toHaveLength(0);
    });

    it('la lista de encargados de un punto no incluye a los del otro', async () => {
      const { norte, sur } = await dosPuntos();
      const elena = await createParticipant(ctx.prisma, norte.id, 'Elena Mora');
      const felipe = await createParticipant(ctx.prisma, sur.id, 'Felipe Cruz');
      await membresias.setRole(elena.id, norte.id, ParticipantRole.SUPERVISOR);
      await membresias.setRole(felipe.id, sur.id, ParticipantRole.SUPERVISOR);

      expect((await supervisores.allSupervisors(norte.id)).map((p) => p.id)).toEqual([elena.id]);
      expect((await supervisores.allSupervisors(sur.id)).map((p) => p.id)).toEqual([felipe.id]);
    });
  });

  describe('la preferencia de avisos depende del punto', () => {
    it('recibe la vacante del punto donde los quiere y no la del otro', async () => {
      const { norte, sur } = await dosPuntos();
      const ana = await createParticipant(ctx.prisma, norte.id, 'Ana López');
      await membresias.join(ana.id, sur.id);

      // Quiere enterarse del sur, pero no del norte.
      await membresias.setCoverageAlerts(ana.id, norte.id, false);
      await membresias.setCoverageAlerts(ana.id, sur.id, true);

      const audienciaNorte = await notificaciones.broadcastAudience(norte.id, []);
      const audienciaSur = await notificaciones.broadcastAudience(sur.id, []);

      expect(audienciaNorte.map((p) => p.id)).not.toContain(ana.id);
      expect(audienciaSur.map((p) => p.id)).toContain(ana.id);
    });

    it('una vacante real solo le llega del punto que sigue', async () => {
      const { norte, sur } = await dosPuntos();
      const ana = await createParticipant(ctx.prisma, norte.id, 'Ana López');
      await membresias.join(ana.id, sur.id);
      await membresias.setCoverageAlerts(ana.id, norte.id, false);

      const turnoNorte = await createShift(ctx.prisma, norte.id, {
        startsAt: new Date('2026-08-30T13:00:00.000Z'),
        capacity: 3,
      });
      const turnoSur = await createShift(ctx.prisma, sur.id, {
        startsAt: new Date('2026-08-30T13:00:00.000Z'),
        capacity: 3,
      });

      await coberturas.openForShift(turnoNorte.id);
      expect(await ctx.prisma.outboxMessage.count({ where: { participantId: ana.id } })).toBe(0);

      await coberturas.openForShift(turnoSur.id);
      expect(
        await ctx.prisma.outboxMessage.count({ where: { participantId: ana.id } }),
      ).toBeGreaterThan(0);
    });
  });

  describe('punto principal', () => {
    it('la primera membresía queda como principal', async () => {
      const { norte } = await dosPuntos();
      const ana = await createParticipant(ctx.prisma, norte.id, 'Ana López');

      expect(await membresias.primaryLocationId(ana.id)).toBe(norte.id);
    });

    it('sumar un segundo punto no cambia el principal', async () => {
      const { norte, sur } = await dosPuntos();
      const ana = await createParticipant(ctx.prisma, norte.id, 'Ana López');
      await membresias.join(ana.id, sur.id);

      expect(await membresias.primaryLocationId(ana.id)).toBe(norte.id);
    });

    it('se puede cambiar, y nunca quedan dos', async () => {
      const { norte, sur } = await dosPuntos();
      const ana = await createParticipant(ctx.prisma, norte.id, 'Ana López');
      await membresias.join(ana.id, sur.id);

      await membresias.setPrimary(ana.id, sur.id);

      expect(await membresias.primaryLocationId(ana.id)).toBe(sur.id);
      const principales = await ctx.prisma.locationMembership.count({
        where: { participantId: ana.id, isPrimary: true },
      });
      expect(principales).toBe(1);
    });

    it('al darse de baja del principal, otro queda promovido', async () => {
      const { norte, sur } = await dosPuntos();
      const ana = await createParticipant(ctx.prisma, norte.id, 'Ana López');
      await membresias.join(ana.id, sur.id);

      await membresias.leave(ana.id, norte.id);

      // Sin promoción, el sistema no sabría a qué punto referir lo que escriba.
      expect(await membresias.primaryLocationId(ana.id)).toBe(sur.id);
    });

    it('sin ningún punto activo, lo informa con un error claro', async () => {
      const { norte } = await dosPuntos();
      const ana = await createParticipant(ctx.prisma, norte.id, 'Ana López');

      await membresias.leave(ana.id, norte.id);

      await expect(membresias.primaryLocationId(ana.id)).rejects.toThrow(
        /no pertenece a ningún punto/,
      );
    });

    it('la base rechaza dos puntos principales a la vez', async () => {
      const { norte, sur } = await dosPuntos();
      const ana = await createParticipant(ctx.prisma, norte.id, 'Ana López');
      await membresias.join(ana.id, sur.id);

      // El índice único parcial es lo que sostiene la invariante incluso si algo
      // escribiera la base por fuera del servicio.
      await expect(
        ctx.prisma.locationMembership.update({
          where: { locationId_participantId: { locationId: sur.id, participantId: ana.id } },
          data: { isPrimary: true },
        }),
      ).rejects.toThrow();
    });

    it('al reactivar una membresía dada de baja, se conserva el principal vigente', async () => {
      const { norte, sur } = await dosPuntos();
      const ana = await createParticipant(ctx.prisma, norte.id, 'Ana López');
      await membresias.join(ana.id, sur.id);
      await membresias.leave(ana.id, sur.id);

      await membresias.join(ana.id, sur.id);

      expect(await membresias.primaryLocationId(ana.id)).toBe(norte.id);
      expect(
        await ctx.prisma.locationMembership.count({
          where: { participantId: ana.id, isPrimary: true },
        }),
      ).toBe(1);
    });
  });

  describe('política de mensajería por punto', () => {
    it('se aplica la del punto que origina el aviso, no la del principal', async () => {
      const { norte, sur } = await dosPuntos();
      const ana = await createParticipant(ctx.prisma, norte.id, 'Ana López');
      await membresias.join(ana.id, sur.id);

      // El norte —su punto principal— entrega a todos; el sur solo a una lista
      // que no la incluye.
      await ctx.prisma.location.update({
        where: { id: sur.id },
        data: { settings: { messagingMode: 'test', allowedRecipients: ['+525599999999'] } },
      });

      const aviso = (locationId: string) => ({
        locationId,
        interactive: (to: string) => MessageBuilder.text(to, 'Aviso'),
        template: { name: 'aviso_encargado', params: ['Aviso'] },
      });

      expect(await notificaciones.send(ana.id, aviso(norte.id))).toBe(true);
      // Si tomara la política del punto principal, este también pasaría.
      expect(await notificaciones.send(ana.id, aviso(sur.id))).toBe(false);
    });
  });

  describe('el padrón es por punto', () => {
    it('cada punto lista solo a su gente, y a los compartidos en ambos', async () => {
      const { norte, sur } = await dosPuntos();
      const soloNorte = await createParticipant(ctx.prisma, norte.id, 'Ana López');
      const soloSur = await createParticipant(ctx.prisma, sur.id, 'Beto Ruiz');
      const ambos = await createParticipant(ctx.prisma, norte.id, 'Carla Díaz');
      await membresias.join(ambos.id, sur.id);

      const delNorte = await ctx.prisma.participant.findMany({
        where: { memberships: { some: { locationId: norte.id, active: true } } },
        select: { id: true },
      });
      const delSur = await ctx.prisma.participant.findMany({
        where: { memberships: { some: { locationId: sur.id, active: true } } },
        select: { id: true },
      });

      expect(delNorte.map((p) => p.id).sort()).toEqual([soloNorte.id, ambos.id].sort());
      expect(delSur.map((p) => p.id).sort()).toEqual([soloSur.id, ambos.id].sort());
    });

    it('da de baja en un punto sin afectar el otro', async () => {
      const { norte, sur } = await dosPuntos();
      const ana = await createParticipant(ctx.prisma, norte.id, 'Ana López');
      await membresias.join(ana.id, sur.id);

      await membresias.leave(ana.id, norte.id);

      const puntos = await membresias.locationsOf(ana.id);
      expect(puntos.map((m) => m.location.name)).toEqual(['Punto Sur']);
    });

    it('lista los puntos de una persona con el principal primero', async () => {
      const { norte, sur } = await dosPuntos();
      const ana = await createParticipant(ctx.prisma, norte.id, 'Ana López');
      await membresias.join(ana.id, sur.id);
      await membresias.setPrimary(ana.id, sur.id);

      const puntos = await membresias.locationsOf(ana.id);
      expect(puntos.map((m) => m.location.name)).toEqual(['Punto Sur', 'Punto Norte']);
      expect(puntos[0].isPrimary).toBe(true);
    });
  });

  it('un punto nuevo puede marcarse como principal al darlo de alta', async () => {
    const { norte, sur } = await dosPuntos();
    const ana = await createParticipant(ctx.prisma, norte.id, 'Ana López');

    await membresias.join(ana.id, sur.id, { makePrimary: true });

    expect(await membresias.primaryLocationId(ana.id)).toBe(sur.id);
  });
});
