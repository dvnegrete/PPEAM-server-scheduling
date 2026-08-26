import { Injectable } from '@nestjs/common';
import { Assignment, SupervisorTask, SupervisorTaskType } from '@prisma/client';
import { TimeService } from '../common/time/time.service';
import { ACTIONS, encodeReply } from '../conversation/reply-ids';
import { MessageBuilder } from '../whatsapp/message-builder';
import { ListRow, OutgoingMessage } from '../whatsapp/types/message.types';

export interface ShiftLike {
  id: string;
  date: Date;
  startMinute: number;
  endMinute: number;
}

/**
 * Redacta lo que lee la gente.
 *
 * Todo el texto de cara al participante vive aquí, separado de la lógica de
 * negocio, para poder ajustar el tono sin tocar las reglas —y para que el
 * mensaje sea idéntico venga de donde venga.
 */
@Injectable()
export class MessageComposer {
  constructor(private readonly time: TimeService) {}

  label(shift: ShiftLike, timezone: string): string {
    return this.time.formatShiftLabel(shift.date, shift.startMinute, shift.endMinute, timezone);
  }

  // -------------------------------------------------------------------------
  // Participante
  // -------------------------------------------------------------------------

  mainMenu(to: string, name: string, isSupervisor: boolean): OutgoingMessage {
    const rows: ListRow[] = [
      { id: encodeReply(ACTIONS.MY_SHIFTS), title: 'Mis turnos', description: 'Ver mis próximos turnos' },
      {
        id: encodeReply(ACTIONS.CANCEL_PICK),
        title: 'Cancelar un turno',
        description: 'Avisar que no podré cubrirlo',
      },
      {
        id: encodeReply(ACTIONS.COVER_LIST),
        title: 'Cubrir un turno',
        description: 'Ver turnos que necesitan apoyo',
      },
      {
        id: encodeReply(ACTIONS.ASK),
        title: 'Hacer una pregunta',
        description: 'Te responde un encargado',
      },
    ];

    if (isSupervisor) {
      rows.push(
        {
          id: encodeReply(ACTIONS.TASKS),
          title: 'Solicitudes',
          description: 'Pendientes por atender',
        },
        {
          id: encodeReply(ACTIONS.DUTY_STATUS),
          title: 'Mi disponibilidad',
          description: 'Conectarme o desconectarme',
        },
      );
    }

    return MessageBuilder.list({
      to,
      header: `Hola, ${name.split(' ')[0]}`,
      body: '¿Qué necesitas hacer?',
      buttonLabel: 'Ver opciones',
      sections: [{ rows }],
    });
  }

  myShifts(
    to: string,
    shifts: Array<{ assignment: Assignment; shift: ShiftLike }>,
    timezone: string,
  ): OutgoingMessage {
    if (shifts.length === 0) {
      return MessageBuilder.text(to, 'No tienes turnos próximos asignados.');
    }

    const lines = shifts.map((item, index) => {
      const estado = item.assignment.status === 'CONFIRMED' ? ' ✓ confirmado' : '';
      return `${index + 1}. ${this.label(item.shift, timezone)}${estado}`;
    });

    return MessageBuilder.text(to, `Tus próximos turnos:\n\n${lines.join('\n')}`);
  }

  pickShiftToCancel(
    to: string,
    shifts: Array<{ assignment: Assignment; shift: ShiftLike }>,
    timezone: string,
  ): OutgoingMessage {
    if (shifts.length === 0) {
      return MessageBuilder.text(to, 'No tienes turnos próximos que cancelar.');
    }

    return MessageBuilder.list({
      to,
      body: '¿Cuál turno no vas a poder cubrir?',
      buttonLabel: 'Elegir turno',
      sections: [
        {
          rows: shifts.slice(0, 10).map((item) => ({
            id: encodeReply(ACTIONS.CANCEL_SELECT, item.assignment.id),
            title: this.time.formatDate(item.shift.date, timezone).slice(0, 24),
            description: this.time.formatRange(item.shift.startMinute, item.shift.endMinute),
          })),
        },
      ],
    });
  }

  confirmCancellation(to: string, shiftLabel: string, assignmentId: string): OutgoingMessage {
    return MessageBuilder.buttons({
      to,
      body: `¿Confirmas que no podrás cubrir ${shiftLabel}?`,
      footer: 'Se avisará de inmediato para buscar quien lo cubra.',
      buttons: [
        { id: encodeReply(ACTIONS.CANCEL_CONFIRM, assignmentId), title: 'Sí, cancelar' },
        { id: encodeReply(ACTIONS.CANCEL_ABORT), title: 'No, regresar' },
      ],
    });
  }

  cancellationDone(to: string, shiftLabel: string, urgent: boolean): OutgoingMessage {
    const base = `Listo. Quedas fuera de ${shiftLabel} y ya se está buscando quien lo cubra.`;
    return MessageBuilder.text(
      to,
      urgent ? `${base}\n\nComo el turno es pronto, se avisó de inmediato a un encargado.` : base,
    );
  }

  availableCoverages(
    to: string,
    coverages: Array<{ id: string; shift: ShiftLike; slotsNeeded: number }>,
    timezone: string,
  ): OutgoingMessage {
    if (coverages.length === 0) {
      return MessageBuilder.text(to, 'Por ahora no hay turnos que necesiten apoyo. ¡Gracias!');
    }

    return MessageBuilder.list({
      to,
      body: 'Estos turnos necesitan apoyo. Elige el que puedas cubrir:',
      buttonLabel: 'Ver turnos',
      sections: [
        {
          rows: coverages.slice(0, 10).map((item) => ({
            id: encodeReply(ACTIONS.COVER_OFFER, item.id),
            title: this.time.formatDate(item.shift.date, timezone).slice(0, 24),
            description: `${this.time.formatRange(item.shift.startMinute, item.shift.endMinute)} · ${item.slotsNeeded} lugar(es)`,
          })),
        },
      ],
    });
  }

  offerReceived(to: string, shiftLabel: string): OutgoingMessage {
    return MessageBuilder.text(
      to,
      `Gracias. Registramos que puedes cubrir ${shiftLabel}.\n\n` +
        'Un encargado lo confirmará y te avisamos en cuanto haya respuesta.',
    );
  }

  coverageApproved(to: string, name: string, shiftLabel: string): OutgoingMessage {
    return MessageBuilder.text(
      to,
      `${name.split(' ')[0]}, tu apoyo quedó confirmado para ${shiftLabel}. ¡Gracias!`,
    );
  }

  coverageNotSelected(to: string, name: string, shiftLabel: string): OutgoingMessage {
    return MessageBuilder.text(
      to,
      `${name.split(' ')[0]}, gracias por ofrecerte para ${shiftLabel}. ` +
        'En esta ocasión el turno ya quedó cubierto por otra persona.',
    );
  }

  reminder(to: string, name: string, shiftLabel: string, assignmentId: string): OutgoingMessage {
    return MessageBuilder.buttons({
      to,
      body: `Hola ${name.split(' ')[0]}, te recordamos tu turno en el exhibidor:\n\n${shiftLabel}\n\n¿Podrás cubrirlo?`,
      buttons: [
        { id: encodeReply(ACTIONS.CONFIRM_SHIFT, assignmentId), title: 'Sí, confirmo' },
        { id: encodeReply(ACTIONS.DECLINE_SHIFT, assignmentId), title: 'No podré' },
      ],
    });
  }

  coverageBroadcast(
    to: string,
    shiftLabel: string,
    slotsNeeded: number,
    coverageRequestId: string,
  ): OutgoingMessage {
    return MessageBuilder.buttons({
      to,
      body:
        `Se necesita apoyo en el exhibidor:\n\n${shiftLabel}\n` +
        `${slotsNeeded} lugar(es) disponible(s).\n\n¿Puedes cubrirlo?`,
      buttons: [
        { id: encodeReply(ACTIONS.COVER_OFFER, coverageRequestId), title: 'Me ofrezco' },
      ],
    });
  }

  askQuestion(to: string): OutgoingMessage {
    return MessageBuilder.text(
      to,
      'Escribe tu pregunta y la haremos llegar al encargado disponible. Te responderá por aquí mismo.',
    );
  }

  questionReceived(to: string): OutgoingMessage {
    return MessageBuilder.text(
      to,
      'Recibimos tu pregunta. Un encargado te responderá por este mismo número.',
    );
  }

  answerFromSupervisor(to: string, supervisorName: string, answer: string): OutgoingMessage {
    return MessageBuilder.text(to, `${answer}\n\n— ${supervisorName}`);
  }

  shiftCancelledNotice(to: string, shiftLabel: string, reason: string): OutgoingMessage {
    return MessageBuilder.text(to, `El turno ${shiftLabel} fue cancelado.\nMotivo: ${reason}`);
  }

  notRegistered(to: string): OutgoingMessage {
    return MessageBuilder.text(
      to,
      'Tu número no está registrado en el sistema de horarios del exhibidor. ' +
        'Pide a un encargado que te dé de alta y con gusto te atendemos por aquí.',
    );
  }

  notUnderstood(to: string): OutgoingMessage {
    return MessageBuilder.buttons({
      to,
      body: 'No estoy seguro de qué necesitas. ¿Te muestro el menú?',
      buttons: [{ id: encodeReply(ACTIONS.MENU), title: 'Ver menú' }],
    });
  }

  // -------------------------------------------------------------------------
  // Encargados
  // -------------------------------------------------------------------------

  supervisorTaskNotice(
    to: string,
    task: SupervisorTask,
    escalated: boolean,
  ): OutgoingMessage {
    const prefijo = escalated
      ? '⚠️ Sin atender: '
      : task.urgent
        ? '🔴 Urgente: '
        : '';
    const payload = task.payload as Record<string, unknown>;

    switch (task.type) {
      case SupervisorTaskType.COVERAGE_APPROVAL: {
        const offers = (payload.offers ?? []) as Array<{ participantName: string }>;
        const nombres = offers.map((offer) => `• ${offer.participantName}`).join('\n');
        return MessageBuilder.buttons({
          to,
          body:
            `${prefijo}Hay quien se ofrece a cubrir ${String(payload.shiftLabel)}:\n\n${nombres}\n\n` +
            '¿Lo revisas?',
          buttons: [{ id: encodeReply(ACTIONS.TASK_OPEN, task.id), title: 'Revisar' }],
        });
      }

      case SupervisorTaskType.CANCELLATION_NOTICE:
        return MessageBuilder.buttons({
          to,
          body:
            `${prefijo}${String(payload.participantName)} canceló ${String(payload.shiftLabel)}.\n` +
            `Quedan ${String(payload.remaining)} de ${String(payload.capacity)} participantes.` +
            (payload.reason ? `\nMotivo: ${String(payload.reason)}` : ''),
          buttons: [{ id: encodeReply(ACTIONS.ACK, task.id), title: 'Enterado' }],
        });

      case SupervisorTaskType.LOW_STAFF_ALERT:
        return MessageBuilder.buttons({
          to,
          body:
            `${prefijo}El turno ${String(payload.shiftLabel)} quedó con ${String(payload.remaining)} participante(s), ` +
            `debajo del mínimo de ${String(payload.minCapacity)}.\n\n¿Qué hacemos?`,
          buttons: [
            { id: encodeReply(ACTIONS.SHIFT_KEEP, task.id), title: 'Mantener' },
            { id: encodeReply(ACTIONS.SHIFT_CANCEL, task.id), title: 'Cancelar turno' },
          ],
        });

      case SupervisorTaskType.QUESTION:
        return MessageBuilder.buttons({
          to,
          body:
            `${prefijo}${String(payload.participantName)} pregunta:\n\n"${String(payload.question)}"`,
          buttons: [{ id: encodeReply(ACTIONS.THREAD_REPLY, task.id), title: 'Responder' }],
        });

      default:
        return MessageBuilder.text(to, `${prefijo}Tienes una solicitud pendiente por revisar.`);
    }
  }

  /**
   * Resumen en texto plano de una solicitud, para el parámetro de la plantilla.
   * Fuera de la ventana de 24 horas es lo único que puede leer el encargado, así
   * que debe bastarle para saber qué pasa sin abrir nada.
   */
  taskSummary(task: SupervisorTask): string {
    const payload = task.payload as Record<string, unknown>;
    const marca = task.urgent ? '🔴 Urgente. ' : '';

    switch (task.type) {
      case SupervisorTaskType.COVERAGE_APPROVAL: {
        const offers = (payload.offers ?? []) as Array<{ participantName: string }>;
        return (
          `${marca}Se ofrecen a cubrir ${String(payload.shiftLabel)}: ` +
          offers.map((offer) => offer.participantName).join(', ')
        );
      }
      case SupervisorTaskType.CANCELLATION_NOTICE:
        return (
          `${marca}${String(payload.participantName)} canceló ${String(payload.shiftLabel)}. ` +
          `Quedan ${String(payload.remaining)} de ${String(payload.capacity)}.`
        );
      case SupervisorTaskType.LOW_STAFF_ALERT:
        return (
          `${marca}${String(payload.shiftLabel)} quedó con ${String(payload.remaining)} participante(s), ` +
          `debajo del mínimo de ${String(payload.minCapacity)}.`
        );
      case SupervisorTaskType.QUESTION:
        return `${marca}${String(payload.participantName)} pregunta: "${String(payload.question)}"`;
      default:
        return `${marca}Tienes una solicitud pendiente por revisar.`;
    }
  }

  offersToApprove(
    to: string,
    shiftLabel: string,
    offers: Array<{ offerId: string; participantName: string; offeredAt: Date }>,
    timezone: string,
  ): OutgoingMessage {
    return MessageBuilder.list({
      to,
      body: `¿A quién apruebas para ${shiftLabel}?`,
      footer: 'En orden de llegada',
      buttonLabel: 'Elegir',
      sections: [
        {
          rows: offers.slice(0, 10).map((offer, index) => ({
            id: encodeReply(ACTIONS.OFFER_APPROVE, offer.offerId),
            title: offer.participantName.slice(0, 24),
            description: `${index + 1}.º en ofrecerse · ${this.time.formatMinutes(
              this.time.minutesOfDay(offer.offeredAt, timezone),
            )}`,
          })),
        },
      ],
    });
  }

  taskAlreadyHandled(to: string): OutgoingMessage {
    return MessageBuilder.text(to, 'Esa solicitud ya fue atendida por otro encargado.');
  }

  taskResolvedByYou(to: string, detail: string): OutgoingMessage {
    return MessageBuilder.text(to, detail);
  }

  pendingTasks(to: string, tasks: SupervisorTask[], timezone: string): OutgoingMessage {
    if (tasks.length === 0) {
      return MessageBuilder.text(to, 'No hay solicitudes pendientes. Todo en orden.');
    }

    return MessageBuilder.list({
      to,
      body: `Tienes ${tasks.length} solicitud(es) pendiente(s):`,
      buttonLabel: 'Ver solicitudes',
      sections: [
        {
          rows: tasks.slice(0, 10).map((task) => ({
            id: encodeReply(ACTIONS.TASK_OPEN, task.id),
            title: this.taskTitle(task).slice(0, 24),
            description: `${task.urgent ? '🔴 ' : ''}${this.time.formatDate(task.createdAt, timezone)}`,
          })),
        },
      ],
    });
  }

  dutyStatus(
    to: string,
    onDuty: boolean,
    windows: Array<{ weekday: number; startMinute: number; endMinute: number }>,
  ): OutgoingMessage {
    const dias = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
    const franjas =
      windows.length > 0
        ? windows
            .map(
              (window) =>
                `• ${dias[window.weekday]}: ${this.time.formatRange(window.startMinute, window.endMinute)}`,
            )
            .join('\n')
        : '• Sin franjas registradas';

    return MessageBuilder.buttons({
      to,
      body:
        `Ahora mismo ${onDuty ? 'sí' : 'no'} estás recibiendo solicitudes.\n\n` +
        `Tus franjas habituales:\n${franjas}`,
      buttons: [
        { id: encodeReply(ACTIONS.DUTY_ON), title: 'Estoy disponible' },
        { id: encodeReply(ACTIONS.DUTY_OFF), title: 'No disponible' },
      ],
    });
  }

  askForAnswer(to: string, participantName: string, question: string): OutgoingMessage {
    return MessageBuilder.text(
      to,
      `Escribe tu respuesta para ${participantName}.\n\nSu pregunta fue:\n"${question}"`,
    );
  }

  answerDelivered(to: string, participantName: string): OutgoingMessage {
    return MessageBuilder.text(to, `Tu respuesta se envió a ${participantName}.`);
  }

  private taskTitle(task: SupervisorTask): string {
    switch (task.type) {
      case SupervisorTaskType.COVERAGE_APPROVAL:
        return 'Aprobar cobertura';
      case SupervisorTaskType.CANCELLATION_NOTICE:
        return 'Cancelación';
      case SupervisorTaskType.LOW_STAFF_ALERT:
        return 'Turno con poco personal';
      case SupervisorTaskType.QUESTION:
        return 'Pregunta';
      case SupervisorTaskType.SIGNUP_REQUEST:
        return 'Alta de participante';
      default:
        return 'Solicitud';
    }
  }
}
