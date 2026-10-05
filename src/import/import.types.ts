export interface RowError {
  /** Número de fila del archivo, contando el encabezado como fila 1. */
  row: number;
  message: string;
  data?: Record<string, string>;
}

export interface ImportResult {
  processed: number;
  created: number;
  updated: number;
  skipped: number;
  errors: RowError[];
  /** Si es true no se escribió nada: solo se validó el archivo. */
  dryRun: boolean;
}

export function emptyResult(dryRun: boolean): ImportResult {
  return { processed: 0, created: 0, updated: 0, skipped: 0, errors: [], dryRun };
}

/** Días de la semana aceptados en el CSV, con y sin acento. */
export const WEEKDAY_BY_NAME: Record<string, number> = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3,
  miércoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
  sábado: 6,
};

export const ROLE_BY_NAME: Record<string, 'PARTICIPANT' | 'SUPERVISOR' | 'ADMIN'> = {
  participante: 'PARTICIPANT',
  participant: 'PARTICIPANT',
  encargado: 'SUPERVISOR',
  encargada: 'SUPERVISOR',
  supervisor: 'SUPERVISOR',
  admin: 'ADMIN',
  administrador: 'ADMIN',
};

/** Estados civiles aceptados en el CSV, con y sin acento. */
export const MARITAL_BY_NAME: Record<string, 'SINGLE' | 'MARRIED' | 'WIDOWED' | 'SEPARATED'> = {
  soltero: 'SINGLE',
  soltera: 'SINGLE',
  casado: 'MARRIED',
  casada: 'MARRIED',
  viudo: 'WIDOWED',
  viuda: 'WIDOWED',
  separado: 'SEPARATED',
  separada: 'SEPARATED',
  divorciado: 'SEPARATED',
  divorciada: 'SEPARATED',
};

/**
 * Matrimonio pendiente de vincular.
 * Se acumula durante la lectura del archivo y se resuelve al final, cuando ya
 * existen todas las personas.
 */
export interface SpouseLink {
  row: number;
  /** Teléfono de quien declara el matrimonio. */
  phoneE164: string;
  /** Teléfono del cónyuge, si también es participante. */
  spousePhone?: string;
  /** Nombre del cónyuge, si no participa. */
  spouseName?: string;
  data: Record<string, string>;
}
