import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SettingsService } from '../common/settings/settings.service';
import { TimeService } from '../common/time/time.service';
import { PrismaService } from '../prisma/prisma.service';

/** Estados de un flujo de varios pasos. */
export const SESSION_STATES = {
  IDLE: 'IDLE',
  /** Esperando que confirme la cancelación con un botón. */
  AWAITING_CANCEL_CONFIRM: 'AWAITING_CANCEL_CONFIRM',
  /** Esperando que escriba su pregunta. */
  AWAITING_QUESTION: 'AWAITING_QUESTION',
  /** Encargado: esperando que escriba la respuesta a un hilo. */
  AWAITING_ANSWER: 'AWAITING_ANSWER',
} as const;

export type SessionState = (typeof SESSION_STATES)[keyof typeof SESSION_STATES];

export interface SessionContext {
  assignmentId?: string;
  threadId?: string;
  taskId?: string;
}

/**
 * Estado del flujo conversacional.
 *
 * Se guarda en base de datos, no en memoria: el proceso puede reiniciarse a
 * mitad de una cancelación y la persona debe poder terminarla. Las sesiones
 * expiran para que un flujo abandonado no atrape los siguientes mensajes.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly time: TimeService,
    private readonly settings: SettingsService,
  ) {}

  async get(participantId: string): Promise<{ state: SessionState; context: SessionContext }> {
    const session = await this.prisma.conversationSession.findUnique({
      where: { participantId },
    });

    if (!session || session.expiresAt < this.time.now()) {
      return { state: SESSION_STATES.IDLE, context: {} };
    }

    return {
      state: session.state as SessionState,
      context: (session.context ?? {}) as SessionContext,
    };
  }

  async set(
    participantId: string,
    locationId: string,
    state: SessionState,
    context: SessionContext = {},
  ): Promise<void> {
    const settings = await this.settings.forLocation(locationId);
    const expiresAt = new Date(this.time.now().getTime() + settings.sessionTtlMinutes * 60_000);

    await this.prisma.conversationSession.upsert({
      where: { participantId },
      create: {
        participantId,
        state,
        context: context as Prisma.InputJsonValue,
        expiresAt,
      },
      update: { state, context: context as Prisma.InputJsonValue, expiresAt },
    });
  }

  async clear(participantId: string): Promise<void> {
    await this.prisma.conversationSession.deleteMany({ where: { participantId } });
  }
}
