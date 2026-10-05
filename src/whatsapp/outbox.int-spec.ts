import { OutboxStatus } from '@prisma/client';
import { createLocation, createParticipant } from '../../test/helpers/fixtures';
import { createFullTestContext, resetDatabase, TestContext } from '../../test/helpers/test-context';
import {
  WHATSAPP_CLIENT,
  WhatsAppClient,
  WhatsAppSendError,
} from './clients/whatsapp-client.interface';
import { MessageBuilder } from './message-builder';
import { OutboxService } from './outbox.service';
import { OutboxWorker } from './outbox.worker';
import { InboundService } from './inbound.service';
import { InboundEvent } from './types/webhook.types';

const NOW = new Date('2026-08-25T18:00:00.000Z');

describe('Outbox de mensajes (integración)', () => {
  let ctx: TestContext;
  let outbox: OutboxService;
  let worker: OutboxWorker;
  let client: WhatsAppClient;

  beforeAll(async () => {
    ctx = await createFullTestContext();
    outbox = ctx.module.get(OutboxService);
    worker = ctx.module.get(OutboxWorker);
    client = ctx.module.get(WHATSAPP_CLIENT);
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    ctx.time.setClock(() => NOW);
    jest.restoreAllMocks();
  });

  it('entrega los mensajes pendientes y guarda el identificador de WhatsApp', async () => {
    await outbox.enqueue(MessageBuilder.text('+525512345678', 'Hola'));

    const entregados = await worker.processBatch();

    expect(entregados).toBe(1);
    const registro = await ctx.prisma.outboxMessage.findFirstOrThrow();
    expect(registro.status).toBe(OutboxStatus.SENT);
    expect(registro.waMessageId).toMatch(/^stub\./);
    expect(registro.sentAt).not.toBeNull();
  });

  it('reintenta más tarde cuando el fallo es pasajero', async () => {
    jest
      .spyOn(client, 'send')
      .mockRejectedValueOnce(new WhatsAppSendError('Servicio no disponible', false, 500, 503));

    await outbox.enqueue(MessageBuilder.text('+525512345678', 'Hola'));
    await worker.processBatch();

    const registro = await ctx.prisma.outboxMessage.findFirstOrThrow();
    expect(registro.status).toBe(OutboxStatus.PENDING);
    expect(registro.attempts).toBe(1);
    // Espera antes de volver a intentar, en vez de golpear a Meta de inmediato.
    expect(registro.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('descarta el mensaje cuando el error es definitivo', async () => {
    jest
      .spyOn(client, 'send')
      .mockRejectedValueOnce(new WhatsAppSendError('Número inexistente', true, 131026, 400));

    await outbox.enqueue(MessageBuilder.text('+525500000000', 'Hola'));
    await worker.processBatch();

    const registro = await ctx.prisma.outboxMessage.findFirstOrThrow();
    expect(registro.status).toBe(OutboxStatus.FAILED);
    expect(registro.error).toContain('Número inexistente');
    expect(registro.attempts).toBe(1);
  });

  it('no encola dos veces un mensaje con la misma llave de idempotencia', async () => {
    const mensaje = MessageBuilder.text('+525512345678', 'Recordatorio');

    await outbox.enqueue(mensaje, { dedupeKey: 'recordatorio:abc' });
    await outbox.enqueue(mensaje, { dedupeKey: 'recordatorio:abc' });

    expect(await ctx.prisma.outboxMessage.count()).toBe(1);
  });

  it('devuelve a la cola lo que quedó atorado por un reinicio', async () => {
    await outbox.enqueue(MessageBuilder.text('+525512345678', 'Hola'));
    await ctx.prisma.outboxMessage.updateMany({
      data: { status: OutboxStatus.SENDING, updatedAt: new Date(Date.now() - 10 * 60_000) },
    });

    await worker.requeueStuck();

    const registro = await ctx.prisma.outboxMessage.findFirstOrThrow();
    expect(registro.status).toBe(OutboxStatus.PENDING);
  });

  it('respeta la fecha de primer intento', async () => {
    await outbox.enqueue(MessageBuilder.text('+525512345678', 'Después'), {
      notBefore: new Date(Date.now() + 3_600_000),
    });

    expect(await worker.processBatch()).toBe(0);
  });
});

describe('Webhook entrante (integración)', () => {
  let ctx: TestContext;
  let inbound: InboundService;

  beforeAll(async () => {
    ctx = await createFullTestContext();
    inbound = ctx.module.get(InboundService);
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    ctx.time.setClock(() => NOW);
  });

  function evento(waMessageId: string, from: string, text: string): InboundEvent {
    return {
      type: 'text',
      waMessageId,
      from,
      rawFrom: from.replace('+', ''),
      receivedAt: NOW,
      text,
    };
  }

  it('procesa una sola vez aunque Meta reintente el mismo mensaje', async () => {
    const location = await createLocation(ctx.prisma);
    const ana = await createParticipant(ctx.prisma, location.id, 'Ana');

    const mensaje = evento('wamid.repetido', ana.phoneE164, 'hola');
    await inbound.ingest([mensaje], []);
    await inbound.ingest([mensaje], []);
    await inbound.ingest([mensaje], []);

    expect(await ctx.prisma.inboundMessage.count()).toBe(1);
    // Y solo se respondió una vez, no tres.
    expect(await ctx.prisma.outboxMessage.count({ where: { toPhone: ana.phoneE164 } })).toBe(1);
  });

  it('reconoce al participante aunque WhatsApp mande el formato con "1"', async () => {
    const location = await createLocation(ctx.prisma);
    const ana = await ctx.prisma.participant.create({
      data: {
        firstName: 'Ana',
        paternalSurname: 'Prueba',
        phoneE164: '+525512349999',
        optInAt: NOW,
      },
    });
    await ctx.prisma.locationMembership.create({
      data: { locationId: location.id, participantId: ana.id },
    });

    // El webhook llega con el "1" que agrega WhatsApp; ya viene normalizado
    // por el parser, pero la búsqueda debe tolerar ambas formas.
    await inbound.ingest([evento('wamid.mx', '+525512349999', 'hola')], []);

    const registrado = await ctx.prisma.inboundMessage.findFirstOrThrow();
    expect(registrado.participantId).toBe(ana.id);
  });

  it('marca la entrega fallida que reporta WhatsApp', async () => {
    const outbox = ctx.module.get(OutboxService);
    await outbox.enqueue(MessageBuilder.text('+525512345678', 'Hola'));
    await ctx.prisma.outboxMessage.updateMany({ data: { waMessageId: 'wamid.enviado' } });

    await inbound.ingest(
      [],
      [
        {
          waMessageId: 'wamid.enviado',
          status: 'failed',
          at: NOW,
          errorMessage: 'Ventana de 24 horas cerrada',
        },
      ],
    );

    const registro = await ctx.prisma.outboxMessage.findFirstOrThrow();
    expect(registro.status).toBe(OutboxStatus.FAILED);
    expect(registro.error).toContain('Ventana de 24 horas');
  });
});
