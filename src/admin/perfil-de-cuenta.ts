import { formalName, fullName } from '../common/names/person-name';

/** Lo mínimo que hace falta para resolver el perfil de una cuenta. */
export interface CuentaConParticipante {
  firstName: string;
  paternalSurname: string;
  maternalSurname: string | null;
  phone: string | null;
  congregation: string | null;
  circuit: string | null;
  city: string | null;
  participant: {
    firstName: string;
    paternalSurname: string;
    maternalSurname: string | null;
    displayName: string | null;
    phoneE164: string;
    congregation: string | null;
    circuit: string | null;
    city: string | null;
  } | null;
}

/** Nombre, teléfono y organización efectivos de una cuenta del panel. */
export interface PerfilDeCuenta {
  firstName: string;
  paternalSurname: string;
  maternalSurname: string | null;
  /** «Ana María López Pérez» */
  fullName: string;
  /** «López Pérez, Ana María», para listados ordenados */
  formalName: string;
  phone: string | null;
  congregation: string | null;
  circuit: string | null;
  city: string | null;
  /** Si estos datos vienen del padrón, y por tanto se editan allí. */
  fromPadron: boolean;
}

/**
 * De dónde salen el nombre, el teléfono y la organización de una cuenta.
 *
 * Si la cuenta está vinculada a alguien del padrón, los suyos son los del
 * participante y las columnas de `admin_users` quedan inertes. Eso evita que el
 * mismo teléfono acabe con dos valores distintos según dónde se mire.
 *
 * Vive en un solo sitio y nadie más compone estos datos, **incluido el login**:
 * el nombre viaja en el token y se usa para sellar la bitácora, así que resolver
 * mal aquí haría que una cuenta vinculada firmara cada cancelación con el nombre
 * inerte de la cuenta en lugar del del padrón.
 */
export function perfilDe(cuenta: CuentaConParticipante): PerfilDeCuenta {
  const fuente = cuenta.participant ?? cuenta;
  const phone = cuenta.participant ? cuenta.participant.phoneE164 : cuenta.phone;

  return {
    firstName: fuente.firstName,
    paternalSurname: fuente.paternalSurname,
    maternalSurname: fuente.maternalSurname,
    fullName: fullName(fuente),
    formalName: formalName(fuente),
    phone,
    congregation: fuente.congregation,
    circuit: fuente.circuit,
    city: fuente.city,
    fromPadron: cuenta.participant !== null,
  };
}

/** Lo que hay que traer de la base para poder resolver el perfil. */
export const PERFIL_INCLUDE = {
  participant: {
    select: {
      firstName: true,
      paternalSurname: true,
      maternalSurname: true,
      displayName: true,
      phoneE164: true,
      congregation: true,
      circuit: true,
      city: true,
    },
  },
} as const;
