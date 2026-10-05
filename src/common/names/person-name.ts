/**
 * Composición del nombre de una persona.
 *
 * El nombre vive separado en tres campos porque en un padrón hispano hacen falta
 * los tres: ordenar por apellido paterno, saber cuál es el nombre de pila para
 * saludar, y distinguir un nombre compuesto de un segundo apellido. Componerlo
 * para mostrar es, por tanto, una decisión de presentación, y vive aquí en lugar
 * de repetirse en cada pantalla y cada mensaje.
 */

export interface PersonName {
  firstName: string;
  paternalSurname: string;
  maternalSurname?: string | null;
  /** Cómo prefiere que se le llame. Gana sobre la composición automática. */
  displayName?: string | null;
}

/**
 * Para padrones y reportes: `López Pérez, Ana María`.
 * Los apellidos van primero para poder recorrer una lista con la vista.
 */
export function formalName(person: PersonName): string {
  const apellidos = [person.paternalSurname, person.maternalSurname]
    .filter((parte): parte is string => Boolean(parte?.trim()))
    .join(' ');

  return apellidos ? `${apellidos}, ${person.firstName}` : person.firstName;
}

/**
 * Para el tablero y los mensajes: `Ana María López`, o el nombre que la persona
 * eligió si lo capturó.
 */
export function displayName(person: PersonName): string {
  const elegido = person.displayName?.trim();
  if (elegido) return elegido;

  return [person.firstName, person.paternalSurname]
    .filter((parte): parte is string => Boolean(parte?.trim()))
    .join(' ');
}

/**
 * Nombre completo, en el orden del habla: `Ana María López Pérez`.
 * Para cuando hace falta identificar sin ambigüedad, como en la bitácora.
 */
export function fullName(person: PersonName): string {
  return [person.firstName, person.paternalSurname, person.maternalSurname]
    .filter((parte): parte is string => Boolean(parte?.trim()))
    .join(' ');
}

/**
 * Con qué se saluda a alguien: `Hola, Ana`.
 *
 * Antes se obtenía partiendo el nombre completo por el primer espacio, lo que
 * acertaba por casualidad y fallaba con un apellido al frente. Ahora sale del
 * campo que corresponde, y si la persona eligió cómo llamarse, se respeta.
 */
export function greetingName(person: PersonName): string {
  const elegido = person.displayName?.trim();
  if (elegido) return elegido.split(/\s+/)[0];

  return person.firstName.trim().split(/\s+/)[0];
}

/** Orden de un padrón: apellido paterno, materno y luego nombre. */
export const PADRON_ORDER = [
  { paternalSurname: 'asc' },
  { maternalSurname: 'asc' },
  { firstName: 'asc' },
] as const;
