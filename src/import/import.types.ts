export interface RowError {
  /** Número de fila del archivo, contando el encabezado como fila 1. */
  row: number;
  message: string;
  /**
   * Quién es esa fila, con los datos que se alcanzaron a leer: «Ana López ·
   * 55 1234 5678». Sin esto, un error en un archivo de cien filas obliga a
   * contar renglones en la hoja de cálculo para saber a quién corregir.
   */
  label?: string;
  data?: Record<string, string>;
}

/** Arma la etiqueta de una fila con lo que haya disponible. */
export function rowLabel(row: Record<string, string>): string {
  const nombre = [
    row.nombre ?? row.name,
    row.apellido_paterno ?? row['apellido paterno'] ?? row.paternal_surname,
    row.apellido_materno ?? row['apellido materno'] ?? row.maternal_surname,
  ]
    .map((parte) => parte?.trim())
    .filter(Boolean)
    .join(' ');

  const telefono = (row.telefono ?? row['teléfono'] ?? row.phone ?? '').trim();

  const partes = [nombre, telefono].filter(Boolean);
  return partes.length > 0 ? partes.join(' · ') : '(fila sin datos legibles)';
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

/**
 * Columnas que entiende la importación del padrón, incluidas las variantes con
 * acento y en inglés. Sirven para avisar de un encabezado irreconocible antes de
 * procesar fila por fila.
 */
export const PARTICIPANT_COLUMNS = [
  'nombre',
  'name',
  'apellido_paterno',
  'apellido paterno',
  'paternal_surname',
  'apellido_materno',
  'apellido materno',
  'maternal_surname',
  'nombre_a_mostrar',
  'nombre a mostrar',
  'display_name',
  'telefono',
  'teléfono',
  'phone',
  'rol',
  'role',
  'congregacion',
  'congregación',
  'congregation',
  'circuito',
  'circuit',
  'ciudad',
  'city',
  'estado_civil',
  'estado civil',
  'conyuge',
  'cónyuge',
  'spouse',
  'conyuge_telefono',
  'cónyuge_teléfono',
  'spouse_phone',
  'alertas',
  'alerts',
  'consentimiento',
  'consent',
] as const;

/** Columnas que entiende la importación de asignaciones fijas. */
export const ASSIGNMENT_COLUMNS = [
  'telefono',
  'teléfono',
  'phone',
  'dia',
  'día',
  'day',
  'inicio',
  'hora',
  'start',
  'semana',
  'week',
] as const;

/** Estados civiles aceptados en el CSV, con sus variantes de género. */
export const MARITAL_BY_NAME: Record<string, 'SOLTERO' | 'CASADO' | 'VIUDO' | 'SEPARADO'> = {
  soltero: 'SOLTERO',
  soltera: 'SOLTERO',
  casado: 'CASADO',
  casada: 'CASADO',
  viudo: 'VIUDO',
  viuda: 'VIUDO',
  separado: 'SEPARADO',
  separada: 'SEPARADO',
  divorciado: 'SEPARADO',
  divorciada: 'SEPARADO',
};

/**
 * Matrimonio pendiente de vincular.
 * Se acumula durante la lectura del archivo y se resuelve al final, cuando ya
 * existen todas las personas.
 */
/** Datos de organización que trae una fila del CSV. */
export interface OrganizationRow {
  congregation: string | null;
  circuit: string | null;
  city: string | null;
}

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
