/**
 * Ordena a la gente de un turno con el capitán al frente.
 *
 * Si su cónyuge también está en ese turno va inmediatamente después: en el
 * tablero y en el rol se leen como pareja, y separarlos por orden alfabético
 * obligaría a buscarlo. El resto conserva el orden en que llegó, así cada vista
 * decide su propio criterio (por nombre, por registro…).
 *
 * Sin capitán, o si el capitán no está entre `items` (canceló ese día), la lista
 * se devuelve en su orden original.
 */
export function captainFirst<T>(
  items: readonly T[],
  captainId: string | null | undefined,
  idOf: (item: T) => string,
  spouseOf: (item: T) => string | null | undefined,
): T[] {
  const capitan = captainId ? items.find((item) => idOf(item) === captainId) : undefined;
  if (!capitan) return [...items];

  const conyugeId = spouseOf(capitan);
  const conyuge = conyugeId ? items.find((item) => idOf(item) === conyugeId) : undefined;

  const frente: T[] = conyuge ? [capitan, conyuge] : [capitan];
  return [...frente, ...items.filter((item) => !frente.includes(item))];
}
