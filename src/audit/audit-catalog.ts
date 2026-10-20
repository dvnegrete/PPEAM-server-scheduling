import { AUDIT_ACTIONS, type AuditAction } from './audit.service';

/**
 * Nombre y categoría de cada acción de la bitácora.
 *
 * Es la única fuente: antes había dos traductores incompletos —el `switch` de
 * `toMovement`, con nueve acciones, y una constante en el panel, con diecisiete—
 * y el resto se mostraba con su clave técnica. La prueba de este archivo falla si
 * alguien añade una acción a `AUDIT_ACTIONS` sin catalogarla aquí.
 */

/** Claves de categoría, que son también las que acepta el filtro de la API. */
export const AUDIT_CATEGORY_IDS = [
  'turnos',
  'cobertura',
  'encargados',
  'padron',
  'turnos_fijos',
  'mensajes',
  'importaciones',
  'cuentas',
] as const;

export type AuditCategoryId = (typeof AUDIT_CATEGORY_IDS)[number];

interface AuditCategory {
  label: string;
  /** Qué acciones caen en esta categoría. */
  actions: readonly AuditAction[];
}

const A = AUDIT_ACTIONS;

export const AUDIT_CATEGORIES: Record<AuditCategoryId, AuditCategory> = {
  turnos: {
    label: 'Turnos y asignaciones',
    actions: [
      A.SHIFT_GENERATED,
      A.SHIFT_CANCELLED,
      A.SHIFT_KEPT,
      A.ASSIGNMENT_CREATED,
      A.ASSIGNMENT_CONFIRMED,
      A.ASSIGNMENT_CANCELLED,
    ],
  },
  cobertura: {
    label: 'Coberturas',
    actions: [
      A.COVERAGE_OPENED,
      A.COVERAGE_BROADCAST,
      A.COVERAGE_OFFERED,
      A.COVERAGE_APPROVED,
      A.COVERAGE_DECLINED,
      A.COVERAGE_AUTO_APPROVED,
      A.COVERAGE_EXPIRED,
    ],
  },
  encargados: {
    label: 'Encargados y solicitudes',
    actions: [
      A.TASK_CREATED,
      A.TASK_CLAIMED,
      A.TASK_RESOLVED,
      A.TASK_AUTO_RESOLVED,
      A.TASK_ESCALATED,
      A.SUPERVISOR_AVAILABLE,
      A.SUPERVISOR_UNAVAILABLE,
    ],
  },
  padron: {
    label: 'Padrón',
    actions: [
      A.PARTICIPANT_CREATED,
      A.PARTICIPANT_UPDATED,
      A.PARTICIPANT_PHONE_CHANGED,
      A.PARTICIPANT_STATUS_CHANGED,
      A.PARTICIPANT_OPTED_IN,
      A.SPOUSE_LINKED,
      A.SPOUSE_UNLINKED,
    ],
  },
  turnos_fijos: {
    label: 'Turnos fijos',
    actions: [A.RECURRING_ASSIGNED, A.RECURRING_UNASSIGNED],
  },
  mensajes: {
    label: 'Preguntas por WhatsApp',
    actions: [A.THREAD_OPENED, A.THREAD_ANSWERED, A.THREAD_CLOSED],
  },
  importaciones: {
    label: 'Importaciones',
    actions: [A.IMPORT_RUN],
  },
  cuentas: {
    label: 'Accesos y cuentas',
    actions: [
      A.ADMIN_LOGIN,
      A.ADMIN_LOGIN_FAILED,
      A.ADMIN_USER_CREATED,
      A.ADMIN_USER_UPDATED,
      A.ADMIN_PASSWORD_RESET,
      A.ADMIN_PASSWORD_CHANGED,
    ],
  },
};

/**
 * Lo único que un encargado no puede ver: quién entró al panel, quién falló al
 * entrar y qué se hizo con las cuentas.
 */
export const ACCIONES_SENSIBLES: readonly AuditAction[] = AUDIT_CATEGORIES.cuentas.actions;

const ETIQUETAS: Record<AuditAction, string> = {
  [A.SHIFT_GENERATED]: 'Turnos generados',
  [A.SHIFT_CANCELLED]: 'Turno cancelado',
  [A.SHIFT_KEPT]: 'Turno sostenido',
  [A.ASSIGNMENT_CREATED]: 'Alta en un turno',
  [A.ASSIGNMENT_CONFIRMED]: 'Confirmación de asistencia',
  [A.ASSIGNMENT_CANCELLED]: 'Cancelación de turno',
  [A.COVERAGE_OPENED]: 'Vacante abierta',
  [A.COVERAGE_BROADCAST]: 'Vacante difundida',
  [A.COVERAGE_OFFERED]: 'Ofrecimiento recibido',
  [A.COVERAGE_APPROVED]: 'Cobertura aprobada',
  [A.COVERAGE_DECLINED]: 'Ofrecimiento descartado',
  [A.COVERAGE_AUTO_APPROVED]: 'Cobertura aprobada por el sistema',
  [A.COVERAGE_EXPIRED]: 'Vacante vencida',
  [A.TASK_CREATED]: 'Solicitud creada',
  [A.TASK_CLAIMED]: 'Solicitud tomada',
  [A.TASK_RESOLVED]: 'Solicitud atendida',
  [A.TASK_AUTO_RESOLVED]: 'Solicitud resuelta por el sistema',
  [A.TASK_ESCALATED]: 'Solicitud escalada',
  [A.SUPERVISOR_AVAILABLE]: 'Encargado disponible',
  [A.SUPERVISOR_UNAVAILABLE]: 'Encargado no disponible',
  [A.PARTICIPANT_CREATED]: 'Alta en el padrón',
  [A.PARTICIPANT_UPDATED]: 'Datos actualizados',
  [A.PARTICIPANT_PHONE_CHANGED]: 'Cambio de teléfono',
  [A.PARTICIPANT_STATUS_CHANGED]: 'Cambio de situación',
  [A.PARTICIPANT_OPTED_IN]: 'Consentimiento registrado',
  [A.SPOUSE_LINKED]: 'Cónyuges vinculados',
  [A.SPOUSE_UNLINKED]: 'Cónyuges desvinculados',
  [A.THREAD_OPENED]: 'Pregunta recibida',
  [A.THREAD_ANSWERED]: 'Pregunta respondida',
  [A.THREAD_CLOSED]: 'Pregunta cerrada',
  [A.RECURRING_ASSIGNED]: 'Turno fijo asignado',
  [A.RECURRING_UNASSIGNED]: 'Turno fijo retirado',
  [A.IMPORT_RUN]: 'Importación',
  [A.ADMIN_LOGIN]: 'Entrada al panel',
  [A.ADMIN_LOGIN_FAILED]: 'Intento de entrada fallido',
  [A.ADMIN_USER_CREATED]: 'Cuenta creada',
  [A.ADMIN_USER_UPDATED]: 'Cuenta modificada',
  [A.ADMIN_PASSWORD_RESET]: 'Contraseña restablecida',
  [A.ADMIN_PASSWORD_CHANGED]: 'Contraseña cambiada',
};

/**
 * Nombre legible de una acción. `AuditEntry.action` es texto libre, así que una
 * acción no catalogada se devuelve tal cual en lugar de romper la pantalla.
 */
export function etiquetaDe(action: string): string {
  return ETIQUETAS[action as AuditAction] ?? action;
}

const POR_ACCION = new Map<string, AuditCategoryId>(
  AUDIT_CATEGORY_IDS.flatMap((id) =>
    AUDIT_CATEGORIES[id].actions.map((action) => [action as string, id] as const),
  ),
);

export function categoriaDe(action: string): AuditCategoryId | null {
  return POR_ACCION.get(action) ?? null;
}
