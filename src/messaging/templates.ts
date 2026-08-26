/**
 * Catálogo de plantillas de Meta.
 *
 * Fuera de la ventana de 24 horas solo se puede escribir con una plantilla
 * aprobada, así que todo mensaje que inicia el sistema tiene que estar aquí.
 * Los nombres deben coincidir exactamente con los dados de alta en el
 * WhatsApp Manager, y el orden de los parámetros con el de su cuerpo.
 */
export const WA_TEMPLATES = {
  /** {{1}} nombre · {{2}} turno · Botones: Confirmo | No podré */
  RECORDATORIO_TURNO: 'recordatorio_turno',

  /** {{1}} turno · {{2}} lugares libres · Botón: Me ofrezco */
  VACANTE_DISPONIBLE: 'vacante_disponible',

  /** {{1}} nombre · {{2}} turno */
  COBERTURA_APROBADA: 'cobertura_aprobada',

  /** {{1}} nombre · {{2}} turno */
  COBERTURA_AGRADECIMIENTO: 'cobertura_agradecimiento',

  /** {{1}} turno · {{2}} motivo */
  TURNO_CANCELADO: 'turno_cancelado',

  /** {{1}} nombre — primer contacto y consentimiento */
  BIENVENIDA_OPTIN: 'bienvenida_optin',

  /** {{1}} mes · {{2}} fecha del quinto día */
  APERTURA_QUINTO_DIA: 'apertura_quinto_dia',

  /** {{1}} resumen de la solicitud — aviso a encargados */
  AVISO_ENCARGADO: 'aviso_encargado',
} as const;

export type WhatsAppTemplateName = (typeof WA_TEMPLATES)[keyof typeof WA_TEMPLATES];

/**
 * Texto equivalente de cada plantilla, usado cuando la conversación sigue
 * abierta (dentro de las 24 horas) y no hace falta gastar una plantilla, y en
 * desarrollo con el driver stub. Mantener ambos textos alineados evita que el
 * participante reciba mensajes distintos según el canal.
 */
export const TEMPLATE_FALLBACK_TEXT: Record<string, (params: string[]) => string> = {
  [WA_TEMPLATES.RECORDATORIO_TURNO]: ([nombre, turno]) =>
    `Hola ${nombre}, te recordamos tu turno en el exhibidor: ${turno}. ¿Podrás cubrirlo?`,
  [WA_TEMPLATES.VACANTE_DISPONIBLE]: ([turno, lugares]) =>
    `Se necesita apoyo en el exhibidor: ${turno} (${lugares} lugar(es) disponible(s)). ¿Puedes cubrirlo?`,
  [WA_TEMPLATES.COBERTURA_APROBADA]: ([nombre, turno]) =>
    `${nombre}, tu apoyo quedó confirmado para ${turno}. ¡Gracias!`,
  [WA_TEMPLATES.COBERTURA_AGRADECIMIENTO]: ([nombre, turno]) =>
    `${nombre}, gracias por ofrecerte para ${turno}. En esta ocasión el turno ya quedó cubierto por otra persona.`,
  [WA_TEMPLATES.TURNO_CANCELADO]: ([turno, motivo]) =>
    `El turno ${turno} fue cancelado. Motivo: ${motivo}`,
  [WA_TEMPLATES.BIENVENIDA_OPTIN]: ([nombre]) =>
    `Hola ${nombre}. Este es el número para gestionar los turnos del exhibidor: aquí puedes cancelar, confirmar, ofrecerte a cubrir un turno o hacer preguntas.`,
  [WA_TEMPLATES.APERTURA_QUINTO_DIA]: ([mes, fecha]) =>
    `Este ${mes} hay un día extra por cubrir: ${fecha}. Puedes apuntarte en los horarios disponibles.`,
  [WA_TEMPLATES.AVISO_ENCARGADO]: ([resumen]) => resumen,
};
