import { MaritalStatus } from '@prisma/client';
import { createLocation, createParticipant } from '../../test/helpers/fixtures';
import { createFullTestContext, resetDatabase, TestContext } from '../../test/helpers/test-context';
import { ParticipantsService } from './participants.service';

describe('Estado civil y cónyuge (integración)', () => {
  let ctx: TestContext;
  let participantes: ParticipantsService;
  let locationId: string;

  beforeAll(async () => {
    ctx = await createFullTestContext();
    participantes = ctx.module.get(ParticipantsService);
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    const location = await createLocation(ctx.prisma);
    locationId = location.id;
  });

  const admin = { actorId: 'admin-1', actorName: 'Elena Mora' };

  it('todo el padrón importado nace sin el dato registrado', async () => {
    const ana = await createParticipant(ctx.prisma, locationId, 'Ana López');
    expect(ana.maritalStatus).toBe(MaritalStatus.UNKNOWN);
  });

  describe('cónyuge que también participa', () => {
    it('queda registrado en ambos con una sola captura', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López');
      const beto = await createParticipant(ctx.prisma, locationId, 'Beto Ruiz');

      await participantes.updateMarital({
        participantId: ana.id,
        maritalStatus: MaritalStatus.MARRIED,
        spouseParticipantId: beto.id,
        ...admin,
      });

      const anaFinal = await ctx.prisma.participant.findUniqueOrThrow({ where: { id: ana.id } });
      const betoFinal = await ctx.prisma.participant.findUniqueOrThrow({ where: { id: beto.id } });

      expect(anaFinal.spouseId).toBe(beto.id);
      expect(betoFinal.spouseId).toBe(ana.id);
      // El matrimonio lo es para los dos, aunque solo se capturara en uno.
      expect(betoFinal.maritalStatus).toBe(MaritalStatus.MARRIED);
      expect(anaFinal.spouseName).toBeNull();
      expect(betoFinal.spouseName).toBeNull();
    });

    it('deja registro en bitácora de quién lo capturó', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López');
      const beto = await createParticipant(ctx.prisma, locationId, 'Beto Ruiz');

      await participantes.updateMarital({
        participantId: ana.id,
        maritalStatus: MaritalStatus.MARRIED,
        spouseParticipantId: beto.id,
        ...admin,
      });

      const registro = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'participant.spouse_linked' },
      });
      expect(registro.actorName).toBe('Elena Mora');
      expect((registro.metadata as { spouseName: string }).spouseName).toBe('Beto Ruiz');
    });

    it('impide casar a alguien que ya figura casado con un tercero', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López');
      const beto = await createParticipant(ctx.prisma, locationId, 'Beto Ruiz');
      const carla = await createParticipant(ctx.prisma, locationId, 'Carla Díaz');

      await participantes.updateMarital({
        participantId: ana.id,
        maritalStatus: MaritalStatus.MARRIED,
        spouseParticipantId: beto.id,
        ...admin,
      });

      await expect(
        participantes.updateMarital({
          participantId: carla.id,
          maritalStatus: MaritalStatus.MARRIED,
          spouseParticipantId: beto.id,
          ...admin,
        }),
      ).rejects.toThrow(/ya figura casado con Ana López/);

      // El vínculo original queda intacto.
      const betoFinal = await ctx.prisma.participant.findUniqueOrThrow({ where: { id: beto.id } });
      expect(betoFinal.spouseId).toBe(ana.id);
    });

    it('al cambiar de cónyuge, el anterior queda libre y no apuntando a nadie', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López');
      const beto = await createParticipant(ctx.prisma, locationId, 'Beto Ruiz');
      const carlos = await createParticipant(ctx.prisma, locationId, 'Carlos Vega');

      await participantes.updateMarital({
        participantId: ana.id,
        maritalStatus: MaritalStatus.MARRIED,
        spouseParticipantId: beto.id,
        ...admin,
      });
      await participantes.updateMarital({
        participantId: ana.id,
        maritalStatus: MaritalStatus.MARRIED,
        spouseParticipantId: carlos.id,
        ...admin,
      });

      const betoFinal = await ctx.prisma.participant.findUniqueOrThrow({ where: { id: beto.id } });
      const carlosFinal = await ctx.prisma.participant.findUniqueOrThrow({
        where: { id: carlos.id },
      });
      expect(betoFinal.spouseId).toBeNull();
      expect(carlosFinal.spouseId).toBe(ana.id);
    });

    it('rechaza que alguien sea su propio cónyuge', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López');

      await expect(
        participantes.updateMarital({
          participantId: ana.id,
          maritalStatus: MaritalStatus.MARRIED,
          spouseParticipantId: ana.id,
          ...admin,
        }),
      ).rejects.toThrow(/su propio cónyuge/);
    });
  });

  describe('cónyuge que no participa', () => {
    it('guarda solo el nombre, sin más datos', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López');

      await participantes.updateMarital({
        participantId: ana.id,
        maritalStatus: MaritalStatus.MARRIED,
        spouseName: 'Julio Hernández',
        ...admin,
      });

      const anaFinal = await ctx.prisma.participant.findUniqueOrThrow({ where: { id: ana.id } });
      expect(anaFinal.spouseName).toBe('Julio Hernández');
      expect(anaFinal.spouseId).toBeNull();
      expect(anaFinal.maritalStatus).toBe(MaritalStatus.MARRIED);
      // No se crea ningún participante por el cónyuge que no participa.
      expect(await ctx.prisma.participant.count()).toBe(1);
    });

    it('no acepta referencia y nombre a la vez', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López');
      const beto = await createParticipant(ctx.prisma, locationId, 'Beto Ruiz');

      await expect(
        participantes.updateMarital({
          participantId: ana.id,
          maritalStatus: MaritalStatus.MARRIED,
          spouseParticipantId: beto.id,
          spouseName: 'Julio Hernández',
          ...admin,
        }),
      ).rejects.toThrow(/no ambos/);
    });

    it('al pasar de nombre a referencia, el nombre se limpia', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López');
      const beto = await createParticipant(ctx.prisma, locationId, 'Beto Ruiz');

      await participantes.updateMarital({
        participantId: ana.id,
        maritalStatus: MaritalStatus.MARRIED,
        spouseName: 'Beto Ruiz',
        ...admin,
      });
      // Después resulta que Beto sí entró al padrón.
      await participantes.updateMarital({
        participantId: ana.id,
        maritalStatus: MaritalStatus.MARRIED,
        spouseParticipantId: beto.id,
        ...admin,
      });

      const anaFinal = await ctx.prisma.participant.findUniqueOrThrow({ where: { id: ana.id } });
      expect(anaFinal.spouseId).toBe(beto.id);
      expect(anaFinal.spouseName).toBeNull();
    });
  });

  describe('otros estados civiles', () => {
    it('no admite cónyuge si el estado no es casado', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López');

      await expect(
        participantes.updateMarital({
          participantId: ana.id,
          maritalStatus: MaritalStatus.SINGLE,
          spouseName: 'Julio Hernández',
          ...admin,
        }),
      ).rejects.toThrow(/estado civil es «casado»/);
    });

    it('al dejar de estar casado se deshace el vínculo por ambos lados', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López');
      const beto = await createParticipant(ctx.prisma, locationId, 'Beto Ruiz');

      await participantes.updateMarital({
        participantId: ana.id,
        maritalStatus: MaritalStatus.MARRIED,
        spouseParticipantId: beto.id,
        ...admin,
      });
      await participantes.updateMarital({
        participantId: ana.id,
        maritalStatus: MaritalStatus.WIDOWED,
        ...admin,
      });

      const anaFinal = await ctx.prisma.participant.findUniqueOrThrow({ where: { id: ana.id } });
      const betoFinal = await ctx.prisma.participant.findUniqueOrThrow({ where: { id: beto.id } });
      expect(anaFinal.maritalStatus).toBe(MaritalStatus.WIDOWED);
      expect(anaFinal.spouseId).toBeNull();
      expect(betoFinal.spouseId).toBeNull();
    });

    it('registra los cuatro estados civiles', async () => {
      for (const estado of [
        MaritalStatus.SINGLE,
        MaritalStatus.MARRIED,
        MaritalStatus.WIDOWED,
        MaritalStatus.SEPARATED,
      ]) {
        const persona = await createParticipant(ctx.prisma, locationId, `Persona ${estado}`);
        await participantes.updateMarital({
          participantId: persona.id,
          maritalStatus: estado,
          ...admin,
        });
        const final = await ctx.prisma.participant.findUniqueOrThrow({ where: { id: persona.id } });
        expect(final.maritalStatus).toBe(estado);
      }
    });
  });

  describe('candidatos a cónyuge', () => {
    it('ofrece solo a quienes no tienen pareja registrada', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López');
      // Beto queda disponible; se comprueba por nombre más abajo.
      await createParticipant(ctx.prisma, locationId, 'Beto Ruiz');
      const carla = await createParticipant(ctx.prisma, locationId, 'Carla Díaz');
      const dora = await createParticipant(ctx.prisma, locationId, 'Dora Sosa');

      // Carla y Dora se casan entre ellas, así que dejan de estar disponibles.
      await participantes.updateMarital({
        participantId: carla.id,
        maritalStatus: MaritalStatus.MARRIED,
        spouseParticipantId: dora.id,
        ...admin,
      });

      const candidatos = await participantes.spouseCandidates(ana.id, locationId);
      expect(candidatos.map((c) => c.fullName)).toEqual(['Beto Ruiz']);
    });

    it('incluye al cónyuge vigente, para poder mostrar la selección actual', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López');
      const beto = await createParticipant(ctx.prisma, locationId, 'Beto Ruiz');

      await participantes.updateMarital({
        participantId: ana.id,
        maritalStatus: MaritalStatus.MARRIED,
        spouseParticipantId: beto.id,
        ...admin,
      });

      const candidatos = await participantes.spouseCandidates(ana.id, locationId);
      expect(candidatos.map((c) => c.fullName)).toContain('Beto Ruiz');
    });

    it('excluye a quien ya está casado con alguien de fuera del padrón', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López');
      const carla = await createParticipant(ctx.prisma, locationId, 'Carla Díaz');
      await createParticipant(ctx.prisma, locationId, 'Beto Ruiz');

      // Carla está casada con alguien que no participa: su `spouseId` queda
      // vacío, pero no por eso está disponible.
      await participantes.updateMarital({
        participantId: carla.id,
        maritalStatus: MaritalStatus.MARRIED,
        spouseName: 'Julio Hernández',
        ...admin,
      });

      const candidatos = await participantes.spouseCandidates(ana.id, locationId);
      expect(candidatos.map((c) => c.fullName)).toEqual(['Beto Ruiz']);
    });

    it('no se ofrece a sí mismo', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López');
      const candidatos = await participantes.spouseCandidates(ana.id, locationId);
      expect(candidatos.map((c) => c.id)).not.toContain(ana.id);
    });
  });

  describe('deshacer el vínculo', () => {
    it('lo quita de ambos y conserva el estado civil', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López');
      const beto = await createParticipant(ctx.prisma, locationId, 'Beto Ruiz');

      await participantes.updateMarital({
        participantId: ana.id,
        maritalStatus: MaritalStatus.MARRIED,
        spouseParticipantId: beto.id,
        ...admin,
      });
      await participantes.unlinkSpouse(ana.id, { id: 'admin-1', name: 'Elena Mora' });

      const anaFinal = await ctx.prisma.participant.findUniqueOrThrow({ where: { id: ana.id } });
      const betoFinal = await ctx.prisma.participant.findUniqueOrThrow({ where: { id: beto.id } });
      expect(anaFinal.spouseId).toBeNull();
      expect(betoFinal.spouseId).toBeNull();
      expect(anaFinal.maritalStatus).toBe(MaritalStatus.MARRIED);
    });
  });

  it('si el cónyuge se borra del padrón, la referencia se limpia sola', async () => {
    const ana = await createParticipant(ctx.prisma, locationId, 'Ana López');
    const beto = await createParticipant(ctx.prisma, locationId, 'Beto Ruiz');

    await participantes.updateMarital({
      participantId: ana.id,
      maritalStatus: MaritalStatus.MARRIED,
      spouseParticipantId: beto.id,
      ...admin,
    });

    await ctx.prisma.participant.delete({ where: { id: beto.id } });

    const anaFinal = await ctx.prisma.participant.findUniqueOrThrow({ where: { id: ana.id } });
    expect(anaFinal.spouseId).toBeNull();
    expect(anaFinal.maritalStatus).toBe(MaritalStatus.MARRIED);
  });
});
