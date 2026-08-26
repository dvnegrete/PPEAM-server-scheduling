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
