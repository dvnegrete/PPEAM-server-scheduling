import { ParticipantRole } from '@prisma/client';
import { createLocation, createParticipant, createShift } from '../../test/helpers/fixtures';
import { createFullTestContext, resetDatabase, TestContext } from '../../test/helpers/test-context';
import { SupervisorsService } from '../supervisors/supervisors.service';
import { InboundService } from '../whatsapp/inbound.service';
import { OutgoingMessage } from '../whatsapp/types/message.types';
import { InboundEvent } from '../whatsapp/types/webhook.types';
import { PrismaService } from '../prisma/prisma.service';

/** Martes 25 de agosto de 2026, 12:00 hora del centro de México. */
const NOW = new Date('2026-08-25T18:00:00.000Z');
const MARTES = 2;

let messageCounter = 0;

function textFrom(phone: string, text: string): InboundEvent {
  messageCounter += 1;
  return {
    type: 'text',
    waMessageId: `wamid.text.${messageCounter}`,
    from: phone,
    rawFrom: phone.replace('+', ''),
    receivedAt: NOW,
    text,
  };
}

function replyFrom(phone: string, replyId: string): InboundEvent {
  messageCounter += 1;
  return {
    type: 'reply',
    waMessageId: `wamid.reply.${messageCounter}`,
    from: phone,
    rawFrom: phone.replace('+', ''),
    receivedAt: NOW,
    replyId,
    source: 'button',
  };
}

describe('Conversación por WhatsApp de extremo a extremo (integración)', () => {
  let ctx: TestContext;
  let inbound: InboundService;
  let supervisors: SupervisorsService;
  let prisma: PrismaService;

  beforeAll(async () => {
    ctx = await createFullTestContext();
    inbound = ctx.module.get(InboundService);
    supervisors = ctx.module.get(SupervisorsService);
    prisma = ctx.prisma;
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    ctx.time.setClock(() => NOW);
  });

  /** Mensajes encolados para un teléfono, en orden. */
  async function outboxFor(phone: string): Promise<OutgoingMessage[]> {
    const rows = await prisma.outboxMessage.findMany({
      where: { toPhone: phone },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => row.payload as unknown as OutgoingMessage);
  }

  async function lastMessageFor(phone: string): Promise<OutgoingMessage> {
    const messages = await outboxFor(phone);
    return messages[messages.length - 1];
  }

  /**
   * Lo que la persona realmente lee. Para las plantillas son sus parámetros:
   * fuera de la ventana de 24 horas ese es todo el contenido que recibe.
   */
  function bodyOf(message: OutgoingMessage): string {
    if (message.kind === 'TEXT') return message.body;
    if (message.kind === 'INTERACTIVE_BUTTONS' || message.kind === 'INTERACTIVE_LIST') {
      return message.body;
    }
    return `${message.templateName} ${message.bodyParams.join(' ')}`;
  }

  /** Acciones disponibles, vengan de botones, de una lista o de una plantilla. */
  function optionIds(message: OutgoingMessage): string[] {
    if (message.kind === 'INTERACTIVE_BUTTONS') return message.buttons.map((b) => b.id);
    if (message.kind === 'INTERACTIVE_LIST') {
      return message.sections.flatMap((section) => section.rows.map((row) => row.id));
    }
    if (message.kind === 'TEMPLATE') return message.buttonPayloads ?? [];
    return [];
  }

  async function escenario() {
    const location = await createLocation(ctx.prisma);
    const ana = await createParticipant(ctx.prisma, location.id, 'Ana López');
    const beto = await createParticipant(ctx.prisma, location.id, 'Beto Ruiz');
    const carla = await createParticipant(ctx.prisma, location.id, 'Carla Díaz');
    const dora = await createParticipant(ctx.prisma, location.id, 'Dora Sosa');
    const elena = await createParticipant(
      ctx.prisma,
      location.id,
      'Elena Mora',
      ParticipantRole.SUPERVISOR,
    );
    // Elena está de guardia los martes de 8:00 a 14:00; son las 12:00.
    await supervisors.addWindow(elena.id, location.id, MARTES, 8 * 60, 14 * 60);

    const shift = await createShift(ctx.prisma, location.id, {
      startsAt: new Date('2026-08-30T13:00:00.000Z'),
      capacity: 3,
      participantIds: [ana.id, beto.id, carla.id],
    });

    return { location, ana, beto, carla, dora, elena, shift };
  }

  it('a un número no registrado le explica cómo darse de alta', async () => {
    await createLocation(ctx.prisma);
    await inbound.ingest([textFrom('+525599999999', 'hola')], []);

    const message = await lastMessageFor('+525599999999');
    expect(bodyOf(message)).toContain('no está registrado');
  });

  it('responde el menú principal a un mensaje cualquiera', async () => {
    const { ana } = await escenario();
    await inbound.ingest([textFrom(ana.phoneE164, 'hola, buenos días')], []);

    const message = await lastMessageFor(ana.phoneE164);
    expect(message.kind).toBe('INTERACTIVE_LIST');
    expect(optionIds(message)).toEqual(
      expect.arrayContaining(['MIS_TURNOS', 'CANCELAR', 'CUBRIR', 'PREGUNTA']),
    );
  });

  it('al participante no le muestra las opciones de encargado', async () => {
    const { ana } = await escenario();
    await inbound.ingest([textFrom(ana.phoneE164, 'hola')], []);

    const ids = optionIds(await lastMessageFor(ana.phoneE164));
    expect(ids).not.toContain('SOLICITUDES');
    expect(ids).not.toContain('GUARDIA');
  });

  it('al encargado sí le muestra sus opciones adicionales', async () => {
    const { elena } = await escenario();
    await inbound.ingest([textFrom(elena.phoneE164, 'hola')], []);

    const ids = optionIds(await lastMessageFor(elena.phoneE164));
    expect(ids).toEqual(expect.arrayContaining(['SOLICITUDES', 'GUARDIA']));
  });

  it('recorre el ciclo completo: cancelación, difusión, ofrecimiento y aprobación', async () => {
    const { ana, dora, elena, shift } = await escenario();

    const labelTurno = 'domingo 30 de agosto';

    // 1. Ana pide cancelar y recibe la lista de sus turnos.
    await inbound.ingest([replyFrom(ana.phoneE164, 'CANCELAR')], []);
    const listaTurnos = await lastMessageFor(ana.phoneE164);
    expect(listaTurnos.kind).toBe('INTERACTIVE_LIST');
    const seleccion = optionIds(listaTurnos)[0];
    expect(seleccion).toMatch(/^CANCELAR_SEL:/);

    // 2. Elige el turno y se le pide confirmación explícita.
    await inbound.ingest([replyFrom(ana.phoneE164, seleccion)], []);
    const confirmacion = await lastMessageFor(ana.phoneE164);
    expect(bodyOf(confirmacion)).toContain('¿Confirmas que no podrás cubrir');
    const confirmar = optionIds(confirmacion).find((id) => id.startsWith('CANCELAR_OK'))!;

    // 3. Confirma: la baja se aplica de inmediato.
    await inbound.ingest([replyFrom(ana.phoneE164, confirmar)], []);
    const acuse = await lastMessageFor(ana.phoneE164);
    expect(bodyOf(acuse)).toContain('Quedas fuera');

    const asignacionAna = await prisma.assignment.findFirstOrThrow({
      where: { shiftId: shift.id, participantId: ana.id },
    });
    expect(asignacionAna.status).toBe('CANCELLED');

    // 4. La vacante se difundió a Dora, que no estaba en el turno.
    const mensajesDora = await outboxFor(dora.phoneE164);
    // Dora no ha escrito hoy, así que le llega como plantilla aprobada.
    const difusion = mensajesDora.find((m) => bodyOf(m).includes(labelTurno));
    expect(difusion).toBeDefined();
    const ofrecerse = optionIds(difusion!).find((id) => id.startsWith('CUBRIR_SEL'))!;

    // 5. Elena, de guardia, recibió el aviso de la cancelación.
    const mensajesElena = await outboxFor(elena.phoneE164);
    expect(mensajesElena.some((m) => bodyOf(m).includes('canceló'))).toBe(true);

    // 6. Dora se ofrece; el lugar todavía no es suyo.
    await inbound.ingest([replyFrom(dora.phoneE164, ofrecerse)], []);
    expect(bodyOf(await lastMessageFor(dora.phoneE164))).toContain('Un encargado lo confirmará');
    expect(
      await prisma.assignment.count({
        where: { shiftId: shift.id, participantId: dora.id, status: 'ASSIGNED' },
      }),
    ).toBe(0);

    // 7. Elena recibe la solicitud de aprobación y la abre.
    const aviso = (await outboxFor(elena.phoneE164)).find((m) => bodyOf(m).includes('Dora Sosa'));
    expect(aviso).toBeDefined();
    const revisar = optionIds(aviso!).find((id) => id.startsWith('SOL:'))!;

    await inbound.ingest([replyFrom(elena.phoneE164, revisar)], []);
    const listaOfrecimientos = await lastMessageFor(elena.phoneE164);
    expect(bodyOf(listaOfrecimientos)).toContain('¿A quién apruebas');
    const aprobar = optionIds(listaOfrecimientos).find((id) => id.startsWith('APROBAR:'))!;

    // 8. Aprueba: Dora queda dentro y ambos reciben su mensaje.
    await inbound.ingest([replyFrom(elena.phoneE164, aprobar)], []);

    const asignacionDora = await prisma.assignment.findFirstOrThrow({
      where: { shiftId: shift.id, participantId: dora.id },
    });
    expect(asignacionDora.status).toBe('ASSIGNED');
    expect(asignacionDora.origin).toBe('COVERAGE');

    expect(bodyOf(await lastMessageFor(dora.phoneE164))).toContain('quedó confirmado');
    expect(bodyOf(await lastMessageFor(elena.phoneE164))).toContain('Dora Sosa');
  });

  it('no deja que otro encargado trabaje una solicitud ya reclamada', async () => {
    const { ana, dora, elena, location } = await escenario();
    const felipe = await createParticipant(
      ctx.prisma,
      location.id,
      'Felipe Cruz',
      ParticipantRole.SUPERVISOR,
    );
    await supervisors.addWindow(felipe.id, location.id, MARTES, 8 * 60, 14 * 60);

    const asignacion = await prisma.assignment.findFirstOrThrow({
      where: { participantId: ana.id },
    });
    await inbound.ingest([replyFrom(ana.phoneE164, `CANCELAR_OK:${asignacion.id}`)], []);

    const request = await prisma.coverageRequest.findFirstOrThrow();
    await inbound.ingest([replyFrom(dora.phoneE164, `CUBRIR_SEL:${request.id}`)], []);

    const task = await prisma.supervisorTask.findFirstOrThrow({
      where: { type: 'COVERAGE_APPROVAL' },
    });

    await inbound.ingest([replyFrom(elena.phoneE164, `SOL:${task.id}`)], []);
    await inbound.ingest([replyFrom(felipe.phoneE164, `SOL:${task.id}`)], []);

    expect(bodyOf(await lastMessageFor(felipe.phoneE164))).toContain('ya fue atendida');
  });

  it('lleva una pregunta al encargado y devuelve su respuesta firmada', async () => {
    const { ana, elena } = await escenario();

    await inbound.ingest([replyFrom(ana.phoneE164, 'PREGUNTA')], []);
    expect(bodyOf(await lastMessageFor(ana.phoneE164))).toContain('Escribe tu pregunta');

    await inbound.ingest([textFrom(ana.phoneE164, '¿Dónde se guarda el exhibidor?')], []);
    expect(bodyOf(await lastMessageFor(ana.phoneE164))).toContain('Un encargado te responderá');

    const aviso = (await outboxFor(elena.phoneE164)).find((m) =>
      bodyOf(m).includes('¿Dónde se guarda el exhibidor?'),
    );
    expect(aviso).toBeDefined();
    // La plantilla lleva el botón que abre la solicitud; abrir una pregunta
    // es justamente pasar a redactar la respuesta.
    const responder = optionIds(aviso!).find((id) => id.startsWith('SOL:'))!;

    await inbound.ingest([replyFrom(elena.phoneE164, responder)], []);
    expect(bodyOf(await lastMessageFor(elena.phoneE164))).toContain('Escribe tu respuesta');

    await inbound.ingest([textFrom(elena.phoneE164, 'Con el hermano encargado del salón.')], []);

    const respuesta = await lastMessageFor(ana.phoneE164);
    expect(bodyOf(respuesta)).toContain('Con el hermano encargado del salón.');
    // La respuesta va firmada, pero llega desde el número único de siempre.
    expect(bodyOf(respuesta)).toContain('— Elena Mora');
  });

  it('permite al encargado conectarse y desconectarse de la guardia', async () => {
    const { elena, location } = await escenario();

    await inbound.ingest([replyFrom(elena.phoneE164, 'GUARDIA_NO')], []);
    expect(bodyOf(await lastMessageFor(elena.phoneE164))).toContain('no recibirás solicitudes');
    expect(await supervisors.onDutyNow(location.id)).toHaveLength(0);

    await inbound.ingest([replyFrom(elena.phoneE164, 'GUARDIA_SI')], []);
    expect(bodyOf(await lastMessageFor(elena.phoneE164))).toContain('ya estás recibiendo');
    expect((await supervisors.onDutyNow(location.id)).map((p) => p.id)).toEqual([elena.id]);
  });

  it('confirma la asistencia desde el recordatorio', async () => {
    const { ana } = await escenario();
    const asignacion = await prisma.assignment.findFirstOrThrow({
      where: { participantId: ana.id },
    });

    await inbound.ingest([replyFrom(ana.phoneE164, `CONFIRMO:${asignacion.id}`)], []);

    const actualizada = await prisma.assignment.findUniqueOrThrow({ where: { id: asignacion.id } });
    expect(actualizada.status).toBe('CONFIRMED');
    expect(bodyOf(await lastMessageFor(ana.phoneE164))).toContain('Gracias por confirmar');
  });

  it('registra el consentimiento la primera vez que alguien escribe', async () => {
    const { ana } = await escenario();
    await prisma.participant.update({ where: { id: ana.id }, data: { optInAt: null } });

    await inbound.ingest([textFrom(ana.phoneE164, 'hola')], []);

    const actualizada = await prisma.participant.findUniqueOrThrow({ where: { id: ana.id } });
    expect(actualizada.optInAt).not.toBeNull();
  });
});
