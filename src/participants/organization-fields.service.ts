import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Los tres campos de organización, para reportes y filtros. */
export const ORGANIZATION_FIELDS = ['congregation', 'circuit', 'city'] as const;
export type OrganizationField = (typeof ORGANIZATION_FIELDS)[number];

/** Etiquetas en español, como se muestran en el panel. */
export const ORGANIZATION_LABELS: Record<OrganizationField, string> = {
  congregation: 'Congregación',
  circuit: 'Circuito',
  city: 'Ciudad',
};

/** Clave de comparación: sin acentos, sin mayúsculas, sin espacios de más. */
function clave(valor: string): string {
  return valor
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('es-MX')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/**
 * Congregación, circuito y ciudad.
 *
 * Son texto libre, pero no se guardan tal cual: si ya existe un valor
 * equivalente —ignorando mayúsculas, acentos y espacios de más— se reutiliza la
 * grafía que ya estaba registrada. Sin eso, «Centro», «centro» y «CENTRO»
 * convivirían y partirían cada reporte en tres filas que son la misma.
 *
 * No es un catálogo: nadie tiene que darlos de alta antes de capturar a una
 * persona. La primera grafía que entra queda como la buena, y las siguientes se
 * alinean a ella.
 */
@Injectable()
export class OrganizationFieldsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Valores ya registrados en un campo, para sugerir mientras se escribe. */
  async knownValues(field: OrganizationField, locationId?: string): Promise<string[]> {
    const filas = (await this.prisma.participant.findMany({
      where: {
        [field]: { not: null },
        ...(locationId ? { memberships: { some: { locationId, active: true } } } : {}),
      },
      select: { [field]: true },
      distinct: [field],
    })) as Array<Partial<Record<OrganizationField, string | null>>>;

    return filas
      .map((fila) => fila[field])
      .filter((valor): valor is string => Boolean(valor))
      .sort((a, b) => a.localeCompare(b, 'es-MX'));
  }

  /**
   * Alinea un valor con la grafía ya registrada, si existe una equivalente.
   * Devuelve `null` para un valor vacío, que es cómo se representa «sin dato».
   */
  async canonical(
    field: OrganizationField,
    valor: string | null | undefined,
  ): Promise<string | null> {
    const limpio = valor?.trim().replace(/\s+/g, ' ');
    if (!limpio) return null;

    const conocidos = await this.knownValues(field);
    const coincidencia = conocidos.find((conocido) => clave(conocido) === clave(limpio));
    return coincidencia ?? limpio;
  }

  /** Resuelve los tres campos de una vez. */
  async canonicalAll(valores: {
    congregation?: string | null;
    circuit?: string | null;
    city?: string | null;
  }): Promise<{ congregation: string | null; circuit: string | null; city: string | null }> {
    return {
      congregation: await this.canonical('congregation', valores.congregation),
      circuit: await this.canonical('circuit', valores.circuit),
      city: await this.canonical('city', valores.city),
    };
  }

  /**
   * Normalizador para procesar muchas filas de una vez.
   *
   * `canonical` consulta la base en cada llamada, lo cual está bien para una
   * captura suelta pero no para una importación: con cien filas por tres campos
   * son cientos de consultas, y contra una base remota eso tarda tanto que el
   * proxy corta la petición antes de que termine.
   *
   * Este normalizador carga los valores conocidos una sola vez y resuelve en
   * memoria. Además **aprende** los que va viendo, para que las grafías
   * equivalentes dentro del mismo archivo se alineen entre sí igual que lo
   * harían contra la base.
   */
  async createNormalizer(): Promise<OrganizationNormalizer> {
    const conocidos = new Map<OrganizationField, Map<string, string>>();

    for (const field of ORGANIZATION_FIELDS) {
      const valores = await this.knownValues(field);
      conocidos.set(field, new Map(valores.map((valor) => [clave(valor), valor])));
    }

    return new OrganizationNormalizer(conocidos);
  }

  /** Cuántas personas hay por valor, para los reportes. */
  async countByField(
    field: OrganizationField,
    locationId: string,
  ): Promise<Array<{ value: string | null; count: number }>> {
    const grupos = await this.prisma.participant.groupBy({
      by: [field],
      where: { memberships: { some: { locationId, active: true } } },
      _count: true,
    });

    return (grupos as Array<Partial<Record<OrganizationField, string | null>> & { _count: number }>)
      .map((grupo) => ({ value: grupo[field] ?? null, count: grupo._count }))
      .sort((a, b) => {
        // Los que no tienen dato van al final: son los que hay que completar.
        if (a.value === null) return 1;
        if (b.value === null) return -1;
        return a.value.localeCompare(b.value, 'es-MX');
      });
  }
}

/** Resuelve los tres campos en memoria, sin volver a la base por cada fila. */
export class OrganizationNormalizer {
  constructor(private readonly conocidos: Map<OrganizationField, Map<string, string>>) {}

  canonical(field: OrganizationField, valor: string | null | undefined): string | null {
    const limpio = valor?.trim().replace(/\s+/g, ' ');
    if (!limpio) return null;

    const porClave = this.conocidos.get(field) ?? new Map<string, string>();
    const k = clave(limpio);
    const existente = porClave.get(k);
    if (existente) return existente;

    // Valor nuevo: queda registrado para que las filas siguientes del mismo
    // archivo se alineen con esta grafía.
    porClave.set(k, limpio);
    this.conocidos.set(field, porClave);
    return limpio;
  }

  canonicalAll(valores: {
    congregation?: string | null;
    circuit?: string | null;
    city?: string | null;
  }): { congregation: string | null; circuit: string | null; city: string | null } {
    return {
      congregation: this.canonical('congregation', valores.congregation),
      circuit: this.canonical('circuit', valores.circuit),
      city: this.canonical('city', valores.city),
    };
  }
}
