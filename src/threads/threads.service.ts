import { Injectable, NotFoundException } from '@nestjs/common';
import { ActorType, ThreadDirection, ThreadStatus } from '@prisma/client';
import { AUDIT_ACTIONS, AuditService } from '../audit/audit.service';
import { displayName, fullName } from '../common/names/person-name';
import { TimeService } from '../common/time/time.service';
import { DomainEventBus } from '../events/domain-event-bus';
import { DOMAIN_EVENTS, QuestionAnsweredEvent, QuestionAskedEvent } from '../events/domain-events';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Puente de preguntas entre participantes y encargados.
 *
 * El participante siempre habla con el mismo número; nunca sabe quién está de
 * guardia. La respuesta sí va firmada con el nombre del encargado, para que la
 * conversación se sienta con una persona y no con un sistema.
 */
@Injectable()
export class ThreadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly time: TimeService,
    private readonly audit: AuditService,
    private readonly events: DomainEventBus,
  ) {}

  async open(participantId: string, locationId: string, question: string): Promise<string> {
    const participant = await this.prisma.participant.findUniqueOrThrow({
      where: { id: participantId },
    });

    const thread = await this.prisma.questionThread.create({
      data: {
        locationId,
        participantId,
        subject: question.slice(0, 80),
        lastMessageAt: this.time.now(),
        messages: {
          create: {
            direction: ThreadDirection.FROM_PARTICIPANT,
            authorId: participantId,
            body: question,
          },
        },
      },
    });

    await this.audit.record({
      actorType: ActorType.PARTICIPANT,
      actorId: participantId,
      action: AUDIT_ACTIONS.THREAD_OPENED,
      entity: 'QuestionThread',
      entityId: thread.id,
    });

    await this.events.publish(DOMAIN_EVENTS.QUESTION_ASKED, {
      locationId,
      threadId: thread.id,
      participantId,
      participantName: displayName(participant),
      question,
    } satisfies QuestionAskedEvent);

    return thread.id;
  }

  async answer(threadId: string, supervisorId: string, answer: string): Promise<void> {
    const thread = await this.prisma.questionThread.findUnique({
      where: { id: threadId },
      include: { participant: true },
    });
    if (!thread) throw new NotFoundException('Esa conversación ya no existe');

    const supervisor = await this.prisma.participant.findUniqueOrThrow({
      where: { id: supervisorId },
    });

    await this.prisma.$transaction([
      this.prisma.threadMessage.create({
        data: {
          threadId,
          direction: ThreadDirection.FROM_SUPERVISOR,
          authorId: supervisorId,
          body: answer,
        },
      }),
      this.prisma.questionThread.update({
        where: { id: threadId },
        data: { status: ThreadStatus.ANSWERED, lastMessageAt: this.time.now() },
      }),
    ]);

    await this.audit.record({
      actorType: ActorType.SUPERVISOR,
      actorId: supervisorId,
      actorName: fullName(supervisor),
      action: AUDIT_ACTIONS.THREAD_ANSWERED,
      entity: 'QuestionThread',
      entityId: threadId,
    });

    await this.events.publish(DOMAIN_EVENTS.QUESTION_ANSWERED, {
      locationId: thread.locationId,
      threadId,
      participantId: thread.participantId,
      supervisorId,
      supervisorName: displayName(supervisor),
      answer,
    } satisfies QuestionAnsweredEvent);
  }

  /** Hilo abierto más reciente de un participante, para continuar la conversación. */
  async openThreadFor(participantId: string) {
    return this.prisma.questionThread.findFirst({
      where: { participantId, status: { in: [ThreadStatus.OPEN, ThreadStatus.ANSWERED] } },
      orderBy: { lastMessageAt: 'desc' },
    });
  }

  async findById(threadId: string) {
    return this.prisma.questionThread.findUnique({
      where: { id: threadId },
      include: { participant: true, messages: { orderBy: { createdAt: 'asc' } } },
    });
  }

  /** Cierra los hilos sin actividad; el cron lo llama a diario. */
  async closeIdle(hours: number): Promise<number> {
    const threshold = new Date(this.time.now().getTime() - hours * 3_600_000);
    const { count } = await this.prisma.questionThread.updateMany({
      where: {
        status: { in: [ThreadStatus.OPEN, ThreadStatus.ANSWERED] },
        lastMessageAt: { lt: threshold },
      },
      data: { status: ThreadStatus.CLOSED, closedAt: this.time.now() },
    });
    return count;
  }
}
