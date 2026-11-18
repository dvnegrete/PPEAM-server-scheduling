import { AssignmentStatus, ShiftStatus } from '@prisma/client';
import { canBeFilled, holdersToSeat, isHolderOn, SyncHolder, SyncShift } from './holder-sync';

const NOW = new Date('2026-11-18T18:00:00.000Z');
const DATE = new Date('2026-12-02T00:00:00.000Z');

function shift(overrides: Partial<SyncShift> = {}): SyncShift {
  return {
    capacity: 3,
    status: ShiftStatus.OPEN,
    startsAt: new Date('2026-12-02T13:00:00.000Z'),
    ...overrides,
  };
}

function holder(participantId: string, overrides: Partial<SyncHolder> = {}): SyncHolder {
  return { participantId, startsOn: null, endsOn: null, ...overrides };
}

describe('holder-sync', () => {
  describe('canBeFilled', () => {
    it('acepta un turno futuro abierto', () => {
      expect(canBeFilled(shift(), NOW)).toBe(true);
    });

    it('rechaza un turno cancelado', () => {
      expect(canBeFilled(shift({ status: ShiftStatus.CANCELLED }), NOW)).toBe(false);
    });

    it('rechaza un turno que ya empezó', () => {
      expect(canBeFilled(shift({ startsAt: new Date('2026-11-18T17:00:00.000Z') }), NOW)).toBe(
        false,
      );
    });
  });

  describe('isHolderOn', () => {
    it('respeta el inicio y el fin de la vigencia', () => {
      expect(isHolderOn(holder('a'), DATE)).toBe(true);
      expect(isHolderOn(holder('a', { startsOn: new Date('2026-12-03') }), DATE)).toBe(false);
      expect(isHolderOn(holder('a', { endsOn: new Date('2026-12-01') }), DATE)).toBe(false);
    });
  });

  describe('holdersToSeat', () => {
    it('sienta a los titulares que faltan hasta llenar el cupo', () => {
      const seated = holdersToSeat(
        shift({ capacity: 2 }),
        [],
        [holder('a'), holder('b'), holder('c')],
        DATE,
        NOW,
      );
      expect(seated.map((h) => h.participantId)).toEqual(['a', 'b']);
    });

    it('no vuelve a sentar a quien ya figura, aunque haya cancelado', () => {
      const seated = holdersToSeat(
        shift(),
        [
          { participantId: 'a', status: AssignmentStatus.ASSIGNED },
          { participantId: 'b', status: AssignmentStatus.CANCELLED },
        ],
        [holder('a'), holder('b'), holder('c')],
        DATE,
        NOW,
      );
      expect(seated.map((h) => h.participantId)).toEqual(['c']);
    });

    it('no sienta a nadie si el turno ya está lleno', () => {
      const seated = holdersToSeat(
        shift({ capacity: 1 }),
        [{ participantId: 'x', status: AssignmentStatus.ASSIGNED }],
        [holder('a')],
        DATE,
        NOW,
      );
      expect(seated).toEqual([]);
    });

    it('no toca un turno que ya pasó', () => {
      const seated = holdersToSeat(
        shift({ startsAt: new Date('2026-11-01T13:00:00.000Z') }),
        [],
        [holder('a')],
        DATE,
        NOW,
      );
      expect(seated).toEqual([]);
    });
  });
});
