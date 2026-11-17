import { Injectable } from '@nestjs/common';
import { ParticipantRole } from '@prisma/client';
import { PADRON_ORDER } from '../common/names/person-name';
import { PhoneService } from '../common/phone/phone.service';
import { PrismaService } from '../prisma/prisma.service';

/** Los campos con los que se compone el nombre de una persona. */
const NAME_SELECT = {
  id: true,
  firstName: true,
  paternalSurname: true,
  maternalSurname: true,
  displayName: true,
} as const;

/**
 * Columnas del padrón. Se comparten entre la consulta y la edición para que el
 * panel reciba exactamente la misma forma por los dos caminos.
 */
function directorySelect(locationId: string) {
  return {
    id: true,
    firstName: true,
    paternalSurname: true,
    maternalSurname: true,
    displayName: true,
    phoneE164: true,
    status: true,
    optInAt: true,
    // El rol y la preferencia de avisos son del vínculo con este punto.
    memberships: {
      where: { locationId },
      select: { role: true, coverageAlerts: true, isPrimary: true },
    },
    maritalStatus: true,
    congregation: true,
    circuit: true,
    city: true,
    spouseName: true,
    spouse: { select: NAME_SELECT },
  } as const;
}

type RowWithMembership = {
  memberships: Array<{ role: ParticipantRole; coverageAlerts: boolean; isPrimary: boolean }>;
};

/** Aplana la membresía, para que el panel no tenga que saber que existe. */
function flattenMembership<T extends RowWithMembership>({ memberships, ...person }: T) {
  return {
    ...person,
    role: memberships[0]?.role ?? 'PARTICIPANT',
    coverageAlerts: memberships[0]?.coverageAlerts ?? true,
    isPrimaryLocation: memberships[0]?.isPrimary ?? false,
  };
}

/**
 * Consultas de lectura del padrón para el panel.
 *
 * Viven aparte de `ParticipantsService`, que se ocupa de crear y modificar: aquí
 * solo se decide qué personas se listan y con qué columnas.
 */
@Injectable()
export class ParticipantDirectoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly phone: PhoneService,
  ) {}

  /** El padrón del punto, con el rol y los avisos de su membresía. */
  async listByLocation(locationId: string) {
    const rows = await this.prisma.participant.findMany({
      where: { memberships: { some: { locationId, active: true } } },
      orderBy: [...PADRON_ORDER],
      select: directorySelect(locationId),
    });

    return rows.map(flattenMembership);
  }

  /** Una sola fila, con la misma forma que `listByLocation`. */
  async rowFor(participantId: string, locationId: string) {
    const row = await this.prisma.participant.findUniqueOrThrow({
      where: { id: participantId },
      select: directorySelect(locationId),
    });

    return flattenMembership(row);
  }

  /** Solo los nombres del padrón del punto, en el orden del padrón. */
  namesByLocation(locationId: string) {
    return this.prisma.participant.findMany({
      where: { memberships: { some: { locationId, active: true } } },
      select: NAME_SELECT,
      orderBy: [...PADRON_ORDER],
    });
  }

  /** Quiénes pueden tomar ese turno, para el selector del tablero. */
  async availableForShift(locationId: string, shiftId: string) {
    const candidates = await this.prisma.participant.findMany({
      where: {
        status: 'ACTIVE',
        OR: [
          { memberships: { some: { locationId, active: true } } },
          // Los de fuera que ya han cubierto **en este punto**. El acotado
          // importa: sin él, cada invitado creado aparecería en todos los puntos
          // para siempre, y la lista dejaría de ser de quien de verdad ha
          // ayudado aquí.
          { external: true, assignments: { some: { shift: { locationId } } } },
        ],
        // Quien ya ocupa un lugar en ese turno no puede volver a tomarlo.
        NOT: {
          assignments: {
            some: { shiftId, status: { in: ['ASSIGNED', 'CONFIRMED'] } },
          },
        },
      },
      select: { ...NAME_SELECT, phoneE164: true, external: true },
      orderBy: [...PADRON_ORDER],
    });

    // El teléfono va ya formateado. Quien se ofrece para cubrir lo hace desde su
    // número, así que es el dato que el administrador tiene a mano para
    // buscarlo; en E.164 crudo no se puede leer ni comparar de un vistazo. Se
    // formatea aquí y no en el panel para no meter la librería de teléfonos en
    // el paquete del navegador, y los dígitos sirven igual para buscar.
    return candidates.map(({ phoneE164, ...person }) => ({
      ...person,
      phone: this.phone.format(phoneE164),
    }));
  }
}
