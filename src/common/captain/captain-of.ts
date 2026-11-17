/**
 * Capitán vigente de un turno según su plantilla, o `null`. Que esté o no entre
 * los ocupantes lo decide cada vista: si canceló, no aparece y nadie lo hereda.
 */
export function captainOf(shift: {
  template: { recurringAssignments: Array<{ participantId: string }> } | null;
}): string | null {
  return shift.template?.recurringAssignments[0]?.participantId ?? null;
}
