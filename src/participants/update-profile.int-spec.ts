import {
  AssignmentStatus,
  MaritalStatus,
  OutboxStatus,
  ParticipantRole,
  ParticipantStatus,
  ShiftStatus,
} from '@prisma/client';
import { createLocation, createParticipant, createShift } from '../../test/helpers/fixtures';
import { createFullTestContext, resetDatabase, TestContext } from '../../test/helpers/test-context';
import { ConversationWindowService } from '../messaging/conversation-window.service';
import { ScheduleGeneratorService } from '../scheduling/schedule-generator.service';
import { MessageBuilder } from '../whatsapp/message-builder';
import { OutboxService } from '../whatsapp/outbox.service';
import { ParticipantProfileService } from './participant-profile.service';

/** Reloj fijo: martes 25 de agosto de 2026, 12:00 hora del centro de México. */
const NOW = new Date('2026-08-25T18:00:00.000Z');

describe('Edición administrativa de un participante (integración)', () => {
  let ctx: TestContext;
  let perfiles: ParticipantProfileService;
  let outbox: OutboxService;
  let ventana: ConversationWindowService;
  let generator: ScheduleGeneratorService;
  let locationId: string;

  beforeAll(async () => {
    ctx = await createFullTestContext();
    perfiles = ctx.module.get(ParticipantProfileService);
    outbox = ctx.module.get(OutboxService);
    ventana = ctx.module.get(ConversationWindowService);
    generator = ctx.module.get(ScheduleGeneratorService);
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    ctx.time.setClock(() => NOW);
    const location = await createLocation(ctx.prisma, { settings: { messagingMode: 'live' } });
    locationId = location.id;
  });

  const admin = { actorId: 'admin-1', actorName: 'Elena Mora' };

  // -------------------------------------------------------------------------
  // Identidad
  // -------------------------------------------------------------------------

  describe('identidad', () => {
    it('solo toca los campos que vienen', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López Pérez');
      await ctx.prisma.participant.update({
        where: { id: ana.id },
        data: { displayName: 'Anita', congregation: 'Centro' },
      });

      const { participant } = await perfiles.updateProfile({
        participantId: ana.id,
        locationId,
        firstName: 'Ana María',
        ...admin,
      });

      expect(participant.firstName).toBe('Ana María');
      // Lo que no se mandó sigue como estaba.
      expect(participant.paternalSurname).toBe('López');
      expect(participant.maternalSurname).toBe('Pérez');
      expect(participant.displayName).toBe('Anita');
      expect(participant.congregation).toBe('Centro');
    });

    it('permite vaciar el apellido materno y el nombre a mostrar', async () => {
      // Es la contraparte de la importación: el CSV ya no borra con una columna
      // vacía, así que el panel tiene que ser la vía para quitar un dato.
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López Pérez');
      await ctx.prisma.participant.update({
        where: { id: ana.id },
        data: { displayName: 'Anita' },
      });

      const { participant } = await perfiles.updateProfile({
        participantId: ana.id,
        locationId,
        maternalSurname: null,
        displayName: '',
        ...admin,
      });

      expect(participant.maternalSurname).toBeNull();
      expect(participant.displayName).toBeNull();
    });

    it('rechaza dejar vacío el nombre o el apellido paterno', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López Pérez');

      await expect(
        perfiles.updateProfile({ participantId: ana.id, locationId, firstName: '  ', ...admin }),
      ).rejects.toThrow(/nombre no puede quedar vacío/);
      await expect(
        perfiles.updateProfile({
          participantId: ana.id,
          locationId,
          paternalSurname: '',
          ...admin,
        }),
      ).rejects.toThrow(/apellido paterno no puede quedar vacío/);
    });

    it('rechaza editar a alguien que no pertenece al punto', async () => {
      const otro = await createLocation(ctx.prisma);
      const ajena = await createParticipant(ctx.prisma, otro.id, 'Sara Vega Díaz');

      await expect(
        perfiles.updateProfile({
          participantId: ajena.id,
          locationId,
          firstName: 'Sarita',
          ...admin,
        }),
      ).rejects.toThrow(/no pertenece a ese punto/);
    });
  });

  // -------------------------------------------------------------------------
  // Teléfono
  // -------------------------------------------------------------------------

  describe('cambio de teléfono', () => {
    it('lo normaliza a E.164 y marca cuándo cambió', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López Pérez');

      const { participant } = await perfiles.updateProfile({
        participantId: ana.id,
        locationId,
        phone: '55 9999 8888',
        ...admin,
      });

      expect(participant.phoneE164).toBe('+525599998888');
      expect(participant.phoneChangedAt).toEqual(NOW);
    });

    it('rechaza un número inválido con un mensaje claro, no un 500', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López Pérez');

      await expect(
        perfiles.updateProfile({ participantId: ana.id, locationId, phone: '123', ...admin }),
      ).rejects.toThrow(/no es válido/);
    });

    it('rechaza un número que ya es de otra persona, nombrándola', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López Pérez');
      const beto = await createParticipant(ctx.prisma, locationId, 'Beto Ruiz Soto');

      await expect(
        perfiles.updateProfile({
          participantId: ana.id,
          locationId,
          phone: beto.phoneE164,
          ...admin,
        }),
      ).rejects.toThrow(/Ruiz Soto, Beto/);
    });

    it('no marca cambio si el número es el mismo en otro formato', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López Pérez');

      const { participant } = await perfiles.updateProfile({
        participantId: ana.id,
        locationId,
        // El mismo número con el «1» que agrega WhatsApp en México.
        phone: ana.phoneE164.replace('+52', '+521'),
        ...admin,
      });

      expect(participant.phoneChangedAt).toBeNull();
      expect(participant.phoneE164).toBe(ana.phoneE164);
    });

    it('conserva el consentimiento, el matrimonio y los turnos', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López Pérez');
      const beto = await createParticipant(ctx.prisma, locationId, 'Beto Ruiz Soto');
      await ctx.prisma.participant.update({
        where: { id: ana.id },
        data: { maritalStatus: MaritalStatus.CASADO, spouseId: beto.id },
      });
      const shift = await createShift(ctx.prisma, locationId, {
        startsAt: new Date('2026-08-30T13:00:00.000Z'),
        participantIds: [ana.id],
      });
      const optInOriginal = (
        await ctx.prisma.participant.findUniqueOrThrow({
          where: { id: ana.id },
        })
      ).optInAt;

      const { participant } = await perfiles.updateProfile({
        participantId: ana.id,
        locationId,
        phone: '55 9999 8888',
        ...admin,
      });

      // El consentimiento es de la persona, no del número: se conserva.
      expect(participant.optInAt).toEqual(optInOriginal);
      expect(participant.maritalStatus).toBe(MaritalStatus.CASADO);
      expect(participant.spouseId).toBe(beto.id);
      expect(
        await ctx.prisma.assignment.count({ where: { participantId: ana.id, shiftId: shift.id } }),
      ).toBe(1);
    });

    it('descarta los envíos que iban al número anterior', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López Pérez');
      await outbox.enqueue(MessageBuilder.text(ana.phoneE164, 'Recordatorio'), {
        participantId: ana.id,
        dedupeKey: 'recordatorio:turno-1',
      });

      const { warnings } = await perfiles.updateProfile({
        participantId: ana.id,
        locationId,
        phone: '55 9999 8888',
        ...admin,
      });

      const registro = await ctx.prisma.outboxMessage.findFirstOrThrow();
      expect(registro.status).toBe(OutboxStatus.CANCELLED);
      expect(warnings.join(' ')).toMatch(/1 mensaje\(s\) que estaban por salir/);
    });

    it('cierra la ventana de servicio, que es del número', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López Pérez');
      await ctx.prisma.inboundMessage.create({
        data: {
          waMessageId: 'wamid.ayer',
          fromPhone: ana.phoneE164,
          participantId: ana.id,
          type: 'text',
          payload: {},
          receivedAt: new Date(NOW.getTime() - 2 * 3_600_000),
        },
      });
      expect(await ventana.isOpen(ana.id)).toBe(true);

      await perfiles.updateProfile({
        participantId: ana.id,
        locationId,
        phone: '55 9999 8888',
        ...admin,
      });

      // El número nuevo nace sin historial: hay que usar plantilla, no texto libre.
      expect(await ventana.isOpen(ana.id)).toBe(false);
    });

    it('avisa cuando el número nuevo no está en la lista blanca de pruebas', async () => {
      const prueba = await createLocation(ctx.prisma, {
        settings: { messagingMode: 'test', allowedRecipients: ['+525511112222'] },
      });
      const ana = await createParticipant(ctx.prisma, prueba.id, 'Ana López Pérez');

      const { warnings } = await perfiles.updateProfile({
        participantId: ana.id,
        locationId: prueba.id,
        phone: '55 9999 8888',
        ...admin,
      });

      // No se bloquea, pero sin el aviso el administrador creería que recibe
      // mensajes: en modo de prueba lo que no está en la lista se omite callado.
      expect(warnings.join(' ')).toMatch(/modo de prueba/);
    });

    it('deja una acción de bitácora propia, distinguible de otros cambios', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López Pérez');
      const anterior = ana.phoneE164;

      await perfiles.updateProfile({
        participantId: ana.id,
        locationId,
        phone: '55 9999 8888',
        ...admin,
      });

      const registro = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'participant.phone_changed' },
      });
      expect(registro.actorName).toBe('Elena Mora');
      expect((registro.before as { phoneE164: string }).phoneE164).toBe(anterior);
      expect((registro.after as { phoneE164: string }).phoneE164).toBe('+525599998888');
    });
  });

  // -------------------------------------------------------------------------
  // Membresía
  // -------------------------------------------------------------------------

  describe('rol y avisos', () => {
    it('los escribe en la membresía del punto, no en la persona', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López Pérez');

      await perfiles.updateProfile({
        participantId: ana.id,
        locationId,
        role: ParticipantRole.SUPERVISOR,
        coverageAlerts: false,
        ...admin,
      });

      const membresia = await ctx.prisma.locationMembership.findFirstOrThrow({
        where: { participantId: ana.id, locationId },
      });
      expect(membresia.role).toBe(ParticipantRole.SUPERVISOR);
      expect(membresia.coverageAlerts).toBe(false);
    });

    it('no afecta su rol en otro punto', async () => {
      const otro = await createLocation(ctx.prisma);
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López Pérez');
      await ctx.prisma.locationMembership.create({
        data: { participantId: ana.id, locationId: otro.id, role: ParticipantRole.PARTICIPANT },
      });

      await perfiles.updateProfile({
        participantId: ana.id,
        locationId,
        role: ParticipantRole.SUPERVISOR,
        ...admin,
      });

      const enElOtro = await ctx.prisma.locationMembership.findFirstOrThrow({
        where: { participantId: ana.id, locationId: otro.id },
      });
      expect(enElOtro.role).toBe(ParticipantRole.PARTICIPANT);
    });
  });

  // -------------------------------------------------------------------------
  // Estado
  // -------------------------------------------------------------------------

  describe('pausa y baja', () => {
    it('cancela los turnos futuros y deja intactos los pasados', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López Pérez');
      const pasado = await createShift(ctx.prisma, locationId, {
        startsAt: new Date('2026-08-20T13:00:00.000Z'),
        participantIds: [ana.id],
      });
      const futuro = await createShift(ctx.prisma, locationId, {
        startsAt: new Date('2026-08-30T13:00:00.000Z'),
        participantIds: [ana.id],
      });

      const { cancelledShifts } = await perfiles.updateProfile({
        participantId: ana.id,
        locationId,
        status: ParticipantStatus.PAUSED,
        ...admin,
      });

      expect(cancelledShifts).toBe(1);
      const enFuturo = await ctx.prisma.assignment.findFirstOrThrow({
        where: { participantId: ana.id, shiftId: futuro.id },
      });
      const enPasado = await ctx.prisma.assignment.findFirstOrThrow({
        where: { participantId: ana.id, shiftId: pasado.id },
      });
      expect(enFuturo.status).toBe(AssignmentStatus.CANCELLED);
      // El historial no se reescribe: ella sí atendió ese turno.
      expect(enPasado.status).toBe(AssignmentStatus.ASSIGNED);
    });

    it('no convoca a nadie ni avisa al encargado', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López Pérez');
      await createShift(ctx.prisma, locationId, {
        startsAt: new Date('2026-08-30T13:00:00.000Z'),
        participantIds: [ana.id],
      });

      await perfiles.updateProfile({
        participantId: ana.id,
        locationId,
        status: ParticipantStatus.INACTIVE,
        ...admin,
      });

      expect(await ctx.prisma.coverageRequest.count()).toBe(0);
      expect(await ctx.prisma.supervisorTask.count()).toBe(0);
      expect(await ctx.prisma.outboxMessage.count()).toBe(0);
    });

    it('deja el hueco visible en el turno', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López Pérez');
      const beto = await createParticipant(ctx.prisma, locationId, 'Beto Ruiz Soto');
      const carla = await createParticipant(ctx.prisma, locationId, 'Carla Díaz Vega');
      const shift = await createShift(ctx.prisma, locationId, {
        startsAt: new Date('2026-08-30T13:00:00.000Z'),
        participantIds: [ana.id, beto.id, carla.id],
      });
      expect((await ctx.prisma.shift.findUniqueOrThrow({ where: { id: shift.id } })).status).toBe(
        ShiftStatus.FULL,
      );

      await perfiles.updateProfile({
        participantId: ana.id,
        locationId,
        status: ParticipantStatus.PAUSED,
        ...admin,
      });

      expect((await ctx.prisma.shift.findUniqueOrThrow({ where: { id: shift.id } })).status).toBe(
        ShiftStatus.OPEN,
      );
    });

    it('conserva su turno fijo pero no lo sienta al generar', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López Pérez');
      const template = await ctx.prisma.shiftTemplate.create({
        data: {
          locationId,
          weekday: 1,
          startMinute: 7 * 60,
          endMinute: 9 * 60,
          capacity: 2,
          weekOfMonth: 0,
        },
      });
      await ctx.prisma.recurringAssignment.create({
        data: { shiftTemplateId: template.id, participantId: ana.id },
      });

      await perfiles.updateProfile({
        participantId: ana.id,
        locationId,
        status: ParticipantStatus.PAUSED,
        ...admin,
      });

      expect((await generator.generateMonth(locationId, 2026, 9)).assignmentsCreated).toBe(0);
      // Pero el turno fijo sigue ahí: al reactivarla recupera su lugar.
      expect(
        await ctx.prisma.recurringAssignment.count({
          where: { participantId: ana.id, active: true },
        }),
      ).toBe(1);
    });

    it('reactivar no cancela nada', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López Pérez');
      await ctx.prisma.participant.update({
        where: { id: ana.id },
        data: { status: ParticipantStatus.PAUSED },
      });
      await createShift(ctx.prisma, locationId, {
        startsAt: new Date('2026-08-30T13:00:00.000Z'),
        participantIds: [ana.id],
      });

      const { cancelledShifts, participant } = await perfiles.updateProfile({
        participantId: ana.id,
        locationId,
        status: ParticipantStatus.ACTIVE,
        ...admin,
      });

      expect(cancelledShifts).toBe(0);
      expect(participant.status).toBe(ParticipantStatus.ACTIVE);
    });

    it('registra el cambio de estado con su propia acción', async () => {
      const ana = await createParticipant(ctx.prisma, locationId, 'Ana López Pérez');

      await perfiles.updateProfile({
        participantId: ana.id,
        locationId,
        status: ParticipantStatus.INACTIVE,
        ...admin,
      });

      const registro = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'participant.status_changed' },
      });
      expect((registro.before as { status: string }).status).toBe(ParticipantStatus.ACTIVE);
      expect((registro.after as { status: string }).status).toBe(ParticipantStatus.INACTIVE);
    });
  });

  // -------------------------------------------------------------------------
  // Un solo guardado que toca todo
  // -------------------------------------------------------------------------

  it('aplica identidad, organización, estado civil y membresía de una vez', async () => {
    const ana = await createParticipant(ctx.prisma, locationId, 'Ana López Pérez');
    const beto = await createParticipant(ctx.prisma, locationId, 'Beto Ruiz Soto');

    const { participant } = await perfiles.updateProfile({
      participantId: ana.id,
      locationId,
      displayName: 'Anita',
      phone: '55 9999 8888',
      role: ParticipantRole.SUPERVISOR,
      coverageAlerts: false,
      congregation: 'Centro',
      city: 'Guadalajara',
      maritalStatus: MaritalStatus.CASADO,
      spouseParticipantId: beto.id,
      ...admin,
    });

    expect(participant.displayName).toBe('Anita');
    expect(participant.phoneE164).toBe('+525599998888');
    expect(participant.congregation).toBe('Centro');
    expect(participant.city).toBe('Guadalajara');
    expect(participant.spouseId).toBe(beto.id);

    const membresia = await ctx.prisma.locationMembership.findFirstOrThrow({
      where: { participantId: ana.id, locationId },
    });
    expect(membresia.role).toBe(ParticipantRole.SUPERVISOR);
    expect(membresia.coverageAlerts).toBe(false);

    // El matrimonio queda simétrico, como si se hubiera capturado por su diálogo.
    const betoFinal = await ctx.prisma.participant.findUniqueOrThrow({ where: { id: beto.id } });
    expect(betoFinal.spouseId).toBe(ana.id);
  });

  it('no escribe nada si la validación falla', async () => {
    // El orden importa: toda la validación va antes del primer update, así que
    // un teléfono inválido no puede dejar el nombre ya cambiado.
    const ana = await createParticipant(ctx.prisma, locationId, 'Ana López Pérez');

    await expect(
      perfiles.updateProfile({
        participantId: ana.id,
        locationId,
        firstName: 'Ana María',
        phone: 'no-es-un-telefono',
        ...admin,
      }),
    ).rejects.toThrow(/no es válido/);

    const sinCambios = await ctx.prisma.participant.findUniqueOrThrow({ where: { id: ana.id } });
    expect(sinCambios.firstName).toBe('Ana');
  });
});
