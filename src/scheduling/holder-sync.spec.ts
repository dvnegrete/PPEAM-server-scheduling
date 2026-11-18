import { AssignmentOrigin, AssignmentStatus, ShiftStatus } from '@prisma/client';
import {
  canBeFilled,
  formerHolders,
  holdersToSeat,
  isHolderOn,
  pendingHolders,
  SyncHolder,
  SyncShift,
} from './holder-sync';

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

  describe('pendingHolders', () => {
    it('incluye a los que no caben, para poder decir cuántos se quedaron fuera', () => {
      const pending = pendingHolders(
        shift({ capacity: 1 }),
        [{ participantId: 'x', status: AssignmentStatus.ASSIGNED }],
        [holder('a'), holder('b')],
        DATE,
        NOW,
      );
      expect(pending.map((h) => h.participantId)).toEqual(['a', 'b']);
    });
  });

  describe('formerHolders', () => {
    const fixed = (
      participantId: string,
      status: AssignmentStatus = AssignmentStatus.ASSIGNED,
    ) => ({
      participantId,
      status,
      origin: AssignmentOrigin.FIXED,
    });

    it('señala solo a quien ocupa por la regla y ya no es titular', () => {
      const released = formerHolders(
        shift(),
        [fixed('a'), fixed('b', AssignmentStatus.CONFIRMED), fixed('c')],
        new Set(['c']),
        NOW,
      );
      expect(released.map((a) => a.participantId)).toEqual(['a', 'b']);
    });

    it('conserva cancelaciones, faltas, coberturas y altas manuales', () => {
      const released = formerHolders(
        shift(),
        [
          fixed('a', AssignmentStatus.CANCELLED),
          fixed('b', AssignmentStatus.NO_SHOW),
          {
            participantId: 'c',
            status: AssignmentStatus.ASSIGNED,
            origin: AssignmentOrigin.COVERAGE,
          },
          {
            participantId: 'd',
            status: AssignmentStatus.ASSIGNED,
            origin: AssignmentOrigin.MANUAL,
          },
          {
            participantId: 'e',
            status: AssignmentStatus.ASSIGNED,
            origin: AssignmentOrigin.SIGNUP,
          },
        ],
        new Set(),
        NOW,
      );
      expect(released).toEqual([]);
    });

    it('no toca turnos pasados ni cancelados', () => {
      expect(
        formerHolders(shift({ status: ShiftStatus.CANCELLED }), [fixed('a')], new Set(), NOW),
      ).toEqual([]);
      expect(
        formerHolders(
          shift({ startsAt: new Date('2026-11-01T13:00:00.000Z') }),
          [fixed('a')],
          new Set(),
          NOW,
        ),
      ).toEqual([]);
    });
  });
});
