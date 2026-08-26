/**
 * Identificadores de los botones y filas de lista.
 *
 * Van y vuelven por WhatsApp, así que se mantienen cortos y explícitos:
 * `ACCION:argumento`. El límite de Meta es 256 caracteres, de sobra para un cuid.
 */
export const ACTIONS = {
  MENU: 'MENU',
  MY_SHIFTS: 'MIS_TURNOS',
  CANCEL_PICK: 'CANCELAR',
  CANCEL_SELECT: 'CANCELAR_SEL',
  CANCEL_CONFIRM: 'CANCELAR_OK',
  CANCEL_ABORT: 'CANCELAR_NO',
  COVER_LIST: 'CUBRIR',
  COVER_OFFER: 'CUBRIR_SEL',
  CONFIRM_SHIFT: 'CONFIRMO',
  DECLINE_SHIFT: 'NO_PODRE',
  ASK: 'PREGUNTA',
  // Encargados
  TASKS: 'SOLICITUDES',
  TASK_OPEN: 'SOL',
  OFFER_APPROVE: 'APROBAR',
  OFFER_DECLINE: 'DESCARTAR',
  DUTY_ON: 'GUARDIA_SI',
  DUTY_OFF: 'GUARDIA_NO',
  DUTY_STATUS: 'GUARDIA',
  SHIFT_KEEP: 'MANTENER',
  SHIFT_CANCEL: 'CANCELAR_TURNO',
  THREAD_REPLY: 'RESPONDER',
  ACK: 'ENTERADO',
} as const;

export type Action = (typeof ACTIONS)[keyof typeof ACTIONS];

export function encodeReply(action: Action, ...args: string[]): string {
  return [action, ...args].join(':');
}

export interface DecodedReply {
  action: string;
  args: string[];
}

export function decodeReply(replyId: string): DecodedReply {
  const [action, ...args] = replyId.split(':');
  return { action, args };
}
