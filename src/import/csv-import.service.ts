import { Injectable, Logger } from '@nestjs/common';
import { ActorType, MaritalStatus, ParticipantRole } from '@prisma/client';
import { parse } from 'csv-parse/sync';
import { AUDIT_ACTIONS, AuditService } from '../audit/audit.service';
import { PhoneService } from '../common/phone/phone.service';
import { TimeService } from '../common/time/time.service';
import { OrganizationFieldsService } from '../participants/organization-fields.service';
import { ParticipantsService } from '../participants/participants.service';
import { formalName } from '../common/names/person-name';
import { PrismaService } from '../prisma/prisma.service';
import {
  ASSIGNMENT_COLUMNS,
  emptyResult,
  rowLabel,
  ImportResult,
  MARITAL_BY_NAME,
  PARTICIPANT_COLUMNS,
  ROLE_BY_NAME,
  SpouseLink,
  WEEKDAY_BY_NAME,
} from './import.types';

/** Fila ya validada, lista para escribirse en lote. */
/** Fila de asignaciones ya validada en su formato, antes de tocar la base. */
interface FilaAsignacion {
  rowNumber: number;
  phoneE164: string;
  /** Tal como venía en el archivo, para que la etiqueta cite lo escrito. */
  rawPhone: string;
  weekday: number;
  startMinute: number;
  weekOfMonth: number;
  /** Como venían en el archivo, para que el mensaje de error cite lo escrito. */
  dayRaw: string;
  startRaw: string;
  data: Record<string, string>;
}

/** Identidad de una franja: es la misma llave que el índice único de la tabla. */
function franjaKey(franja: { weekday: number; startMinute: number; weekOfMonth: number }): string {
  return `${franja.weekday}:${franja.startMinute}:${franja.weekOfMonth}`;
}

interface FilaValidada {
  phoneE164: string;
  datos: {
    firstName: string;
    paternalSurname: string;
    maternalSurname: string | null;
    displayName: string | null;
    congregation: string | null;
    circuit: string | null;
    city: string | null;
    maritalStatus: MaritalStatus;
  };
  /** `null` cuando el archivo no traía la columna: no se toca lo ya registrado. */
  role: ParticipantRole | null;
  /** `null` cuando el archivo no traía la columna. */
  coverageAlerts: boolean | null;
  hasConsent: boolean;
  /** Qué columnas venían en el archivo, para no borrar lo capturado a mano. */
  traia: {
    maternalSurname: boolean;
    displayName: boolean;
    congregation: boolean;
    circuit: boolean;
    city: boolean;
    maritalStatus: boolean;
  };
}

interface ImportOptions {
  locationId: string;
  dryRun?: boolean;
  actorId?: string | null;
}

/**
 * Carga inicial desde hoja de cálculo.
 *
 * Valida fila por fila y reporta todos los errores juntos en lugar de detenerse
 * en el primero: quien prepara el archivo necesita ver de una vez todo lo que
 * hay que corregir. El modo de prueba permite revisar antes de escribir nada.
 */
@Injectable()
export class CsvImportService {
  private readonly logger = new Logger(CsvImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly phone: PhoneService,
    private readonly time: TimeService,
    private readonly audit: AuditService,
    private readonly participants: ParticipantsService,
    private readonly organization: OrganizationFieldsService,
  ) {}

  /**
   * Padrón de participantes.
   *
   * Obligatorias: `nombre`, `apellido_paterno`, `telefono`. Opcionales:
   * `apellido_materno`, `nombre_a_mostrar`, `rol`, `congregacion`, `circuito`,
   * `ciudad`, `estado_civil`, `conyuge`, `conyuge_telefono`, `alertas` y
   * `consentimiento`.
   *
   * Sobre el consentimiento: la política de Meta exige poder demostrar que la
   * persona aceptó recibir mensajes, no que haya escrito primero por WhatsApp.
   * Al importar el padrón, el administrador declara que quienes vienen en el
   * archivo ya participan y aceptaron; sin ese registro no se les podría avisar
   * de una sola vacante, porque para escribir tendrían que haber escrito antes.
   * Quien no lo haya dado se marca con `consentimiento` en `no`.
   */
  async importParticipants(csv: string, options: ImportOptions): Promise<ImportResult> {
    const result = emptyResult(options.dryRun ?? false);
    const rows = this.parseCsv(csv, result, PARTICIPANT_COLUMNS);
    const vinculos: SpouseLink[] = [];

    // Los valores conocidos se cargan una sola vez. Consultarlos por cada fila
    // hacía que un archivo de cien renglones tardara minutos contra una base
    // remota, y el proxy cortaba la petición antes de que terminara.
    const normalizador = await this.organization.createNormalizer();
    const validas: FilaValidada[] = [];

    for (const [index, row] of rows.entries()) {
      const rowNumber = index + 2;
      result.processed += 1;
      const firstName = (row.nombre ?? row.name ?? '').trim();
      const paternalSurname = (
        row.apellido_paterno ??
        row['apellido paterno'] ??
        row.paternal_surname ??
        ''
      ).trim();
      const maternalSurname = (
        row.apellido_materno ??
        row['apellido materno'] ??
        row.maternal_surname ??
        ''
      ).trim();
      const displayNameRaw = (
        row.nombre_a_mostrar ??
        row['nombre a mostrar'] ??
        row.display_name ??
        ''
      ).trim();
      const rawPhone = (row.telefono ?? row.teléfono ?? row.phone ?? '').trim();

      if (!firstName) {
        result.errors.push({
          row: rowNumber,
          message: 'Falta el nombre',
          label: rowLabel(row),
          data: row,
        });
        continue;
      }
      if (!paternalSurname) {
        // Sin compatibilidad silenciosa con el formato anterior: aceptar
        // «Ana López» en la columna `nombre` guardaría el apellido dentro del
        // nombre y nadie lo notaría hasta ver un saludo equivocado.
        result.errors.push({
          row: rowNumber,
          message:
            'Falta el apellido paterno. El padrón ahora se captura en tres columnas: ' +
            'nombre, apellido_paterno y apellido_materno (esta última opcional)',
          label: rowLabel(row),
          data: row,
        });
        continue;
      }
      if (!rawPhone) {
        result.errors.push({
          row: rowNumber,
          message: 'Falta el teléfono',
          label: rowLabel(row),
          data: row,
        });
        continue;
      }

      const phoneE164 = this.phone.tryNormalize(rawPhone);
      if (!phoneE164) {
        result.errors.push({
          row: rowNumber,
          message: `El teléfono "${rawPhone}" no es válido`,
          label: rowLabel(row),
          data: row,
        });
        continue;
      }

      const roleRaw = (row.rol ?? row.role ?? '').trim().toLowerCase();
      if (roleRaw && !ROLE_BY_NAME[roleRaw]) {
        result.errors.push({
          row: rowNumber,
          message:
            `Rol desconocido "${roleRaw}". Usa participante, encargado o encargada, ` +
            `o admin o administrador`,
          label: rowLabel(row),
          data: row,
        });
        continue;
      }
      // Sin columna no hay nada que escribir: al reimportar, un rol vacío no
      // debe degradar a un encargado que se marcó a mano en el panel. El valor
      // por omisión se aplica al dar de alta, no al actualizar.
      const role = roleRaw ? ROLE_BY_NAME[roleRaw] : null;

      const alertsRaw = (row.alertas ?? row.alerts ?? '').trim().toLowerCase();
      const coverageAlerts = alertsRaw === '' ? null : !['no', 'false', '0'].includes(alertsRaw);

      const consentRaw = (row.consentimiento ?? row.consent ?? '').trim().toLowerCase();
      const hasConsent = consentRaw === '' ? true : !['no', 'false', '0'].includes(consentRaw);

      const congregacion = (
        row.congregacion ??
        row['congregación'] ??
        row.congregation ??
        ''
      ).trim();
      const circuito = (row.circuito ?? row.circuit ?? '').trim();
      const ciudad = (row.ciudad ?? row.city ?? '').trim();
      const organizacion = normalizador.canonicalAll({
        congregation: congregacion,
        circuit: circuito,
        city: ciudad,
      });

      const civilRaw = (row.estado_civil ?? row['estado civil'] ?? '').trim().toLowerCase();
      if (civilRaw && !MARITAL_BY_NAME[civilRaw]) {
        result.errors.push({
          row: rowNumber,
          message:
            `Estado civil desconocido "${civilRaw}". Usa soltero, casado, viudo, separado o ` +
            `divorciado, en masculino o femenino`,
          label: rowLabel(row),
          data: row,
        });
        continue;
      }
      const maritalStatus = MARITAL_BY_NAME[civilRaw] ?? MaritalStatus.SIN_REGISTRAR;

      const spouseNameRaw = (row.conyuge ?? row['cónyuge'] ?? row.spouse ?? '').trim();
      const spousePhoneRaw = (
        row.conyuge_telefono ??
        row['cónyuge_teléfono'] ??
        row.spouse_phone ??
        ''
      ).trim();

      if ((spouseNameRaw || spousePhoneRaw) && maritalStatus !== MaritalStatus.CASADO) {
        result.errors.push({
          row: rowNumber,
          message: 'Se indicó cónyuge pero el estado civil no es «casado»',
          label: rowLabel(row),
          data: row,
        });
        continue;
      }

      // El vínculo se resuelve en una segunda pasada: el cónyuge puede aparecer
      // más abajo en el archivo y todavía no existir cuando se lee esta fila.
      if (spousePhoneRaw) {
        const spousePhone = this.phone.tryNormalize(spousePhoneRaw);
        if (!spousePhone) {
          result.errors.push({
            row: rowNumber,
            message: `El teléfono del cónyuge "${spousePhoneRaw}" no es válido`,
            label: rowLabel(row),
            data: row,
          });
          continue;
        }
        vinculos.push({ row: rowNumber, phoneE164, spousePhone, data: row });
      } else if (spouseNameRaw) {
        vinculos.push({ row: rowNumber, phoneE164, spouseName: spouseNameRaw, data: row });
      }

      // La fila quedó validada: se guarda para escribirla en lote más abajo.
      validas.push({
        phoneE164,
        datos: {
          firstName,
          paternalSurname,
          maternalSurname: maternalSurname || null,
          displayName: displayNameRaw || null,
          congregation: organizacion.congregation,
          circuit: organizacion.circuit,
          city: organizacion.city,
          maritalStatus,
        },
        role,
        coverageAlerts,
        hasConsent,
        // Qué columnas venían en el archivo: una vacía no debe borrar un dato
        // que se capturó a mano en el panel.
        traia: {
          maternalSurname: Boolean(maternalSurname),
          displayName: Boolean(displayNameRaw),
          congregation: Boolean(congregacion),
          circuit: Boolean(circuito),
          city: Boolean(ciudad),
          maritalStatus: Boolean(civilRaw),
        },
      });
    }

    await this.writeParticipants(validas, result, options);
    await this.resolveSpouseLinks(vinculos, result, options);
    await this.recordAudit('participants', result, options);
    return result;
  }

  /**
   * Escribe las filas validadas en el menor número de viajes posible.
   *
   * Antes cada fila hacía ocho consultas —buscar, escribir y una transacción
   * completa para la membresía—, así que un padrón de ciento treinta renglones
   * sumaba más de mil viajes a la base. Contra una base remota eso tardaba cerca
   * de minuto y medio y el proxy cortaba la petición: el navegador veía un error
   * aunque el servidor terminara bien.
   *
   * Ahora se precarga lo que hace falta de una vez, los registros nuevos entran
   * en una sola inserción y las membresías se agrupan por valor.
   */
  private async writeParticipants(
    validas: FilaValidada[],
    result: ImportResult,
    options: ImportOptions,
  ): Promise<void> {
    if (validas.length === 0) return;

    // Una consulta para saber quiénes ya están en el padrón, con todas las
    // variantes de cada teléfono.
    const variantes = validas.flatMap((fila) => this.phone.lookupVariants(fila.phoneE164));
    const existentes = await this.prisma.participant.findMany({
      where: { phoneE164: { in: variantes } },
      include: { memberships: { select: { locationId: true, active: true, isPrimary: true } } },
    });

    const porTelefono = new Map<string, (typeof existentes)[number]>();
    for (const persona of existentes) {
      for (const variante of this.phone.lookupVariants(persona.phoneE164)) {
        porTelefono.set(variante, persona);
      }
    }

    if (result.dryRun) {
      for (const fila of validas) {
        if (porTelefono.has(fila.phoneE164)) result.updated += 1;
        else result.created += 1;
      }
      return;
    }

    const nuevas = validas.filter((fila) => !porTelefono.has(fila.phoneE164));
    const repetidas = validas.filter((fila) => porTelefono.has(fila.phoneE164));

    // Los nuevos entran en una sola inserción, con sus membresías en otra.
    if (nuevas.length > 0) {
      const creados = await this.prisma.participant.createManyAndReturn({
        data: nuevas.map((fila) => ({
          ...fila.datos,
          phoneE164: fila.phoneE164,
          optInAt: fila.hasConsent ? this.time.now() : null,
        })),
        select: { id: true, phoneE164: true },
      });

      const filaPorTelefono = new Map(nuevas.map((fila) => [fila.phoneE164, fila]));
      await this.prisma.locationMembership.createMany({
        data: creados.map((persona) => {
          const fila = filaPorTelefono.get(persona.phoneE164);
          return {
            participantId: persona.id,
            locationId: options.locationId,
            // En un alta nueva no hay nada que conservar, así que la columna
            // ausente se resuelve con el valor por omisión.
            role: fila?.role ?? 'PARTICIPANT',
            coverageAlerts: fila?.coverageAlerts ?? true,
            // Es su primera membresía, así que es la principal: alguien siempre
            // necesita un punto por omisión.
            isPrimary: true,
          };
        }),
      });
      result.created += creados.length;
    }

    // Los que ya estaban se actualizan uno por uno, porque cada quien trae
    // valores distintos; es el único bucle que queda.
    for (const fila of repetidas) {
      const persona = porTelefono.get(fila.phoneE164)!;
      await this.prisma.participant.update({
        where: { id: persona.id },
        data: {
          firstName: fila.datos.firstName,
          paternalSurname: fila.datos.paternalSurname,
          ...(fila.traia.maternalSurname ? { maternalSurname: fila.datos.maternalSurname } : {}),
          ...(fila.traia.displayName ? { displayName: fila.datos.displayName } : {}),
          ...(fila.traia.congregation ? { congregation: fila.datos.congregation } : {}),
          ...(fila.traia.circuit ? { circuit: fila.datos.circuit } : {}),
          ...(fila.traia.city ? { city: fila.datos.city } : {}),
          // Un consentimiento ya registrado conserva su fecha original: interesa
          // cuándo se obtuvo por primera vez.
          optInAt: fila.hasConsent ? (persona.optInAt ?? this.time.now()) : null,
          ...(fila.traia.maritalStatus ? { maritalStatus: fila.datos.maritalStatus } : {}),
        },
      });
      result.updated += 1;
    }

    // Las membresías de los repetidos: las que faltan se crean juntas y las que
    // existen se actualizan agrupadas por valor, que son dos o tres grupos.
    const sinMembresia = repetidas.filter(
      (fila) =>
        !porTelefono
          .get(fila.phoneE164)!
          .memberships.some((m) => m.locationId === options.locationId),
    );

    if (sinMembresia.length > 0) {
      await this.prisma.locationMembership.createMany({
        data: sinMembresia.map((fila) => {
          const persona = porTelefono.get(fila.phoneE164)!;
          return {
            participantId: persona.id,
            locationId: options.locationId,
            role: fila.role ?? 'PARTICIPANT',
            coverageAlerts: fila.coverageAlerts ?? true,
            // Solo es principal si no tenía ninguna activa en otro punto.
            isPrimary: !persona.memberships.some((m) => m.active),
          };
        }),
        skipDuplicates: true,
      });
    }

    // Se agrupan por los valores a escribir, para no hacer una consulta por
    // persona. Una columna ausente vale «no tocar» y forma su propio grupo, en
    // lugar de arrastrar consigo el valor por omisión.
    const conMembresia = repetidas.filter((fila) => !sinMembresia.includes(fila));
    const grupos = new Map<
      string,
      { role: ParticipantRole | null; coverageAlerts: boolean | null; ids: string[] }
    >();
    for (const fila of conMembresia) {
      const clave = `${fila.role ?? '-'}|${fila.coverageAlerts ?? '-'}`;
      const grupo = grupos.get(clave) ?? {
        role: fila.role,
        coverageAlerts: fila.coverageAlerts,
        ids: [],
      };
      grupo.ids.push(porTelefono.get(fila.phoneE164)!.id);
      grupos.set(clave, grupo);
    }

    for (const grupo of grupos.values()) {
      await this.prisma.locationMembership.updateMany({
        where: { locationId: options.locationId, participantId: { in: grupo.ids } },
        data: {
          active: true,
          ...(grupo.role !== null ? { role: grupo.role } : {}),
          ...(grupo.coverageAlerts !== null ? { coverageAlerts: grupo.coverageAlerts } : {}),
        },
      });
    }
  }

  /**
   * Segunda pasada: vincula a los matrimonios una vez que todas las filas
   * existen. Hacerlo aquí y no fila por fila permite que un cónyuge aparezca
   * más abajo en el archivo que la persona que lo declara.
   */
  private async resolveSpouseLinks(
    vinculos: SpouseLink[],
    result: ImportResult,
    options: ImportOptions,
  ): Promise<void> {
    if (vinculos.length === 0 || result.dryRun) return;

    for (const vinculo of vinculos) {
      const persona = await this.prisma.participant.findFirst({
        where: { phoneE164: { in: this.phone.lookupVariants(vinculo.phoneE164) } },
      });
      if (!persona) continue;

      try {
        if (vinculo.spousePhone) {
          const conyuge = await this.prisma.participant.findFirst({
            where: { phoneE164: { in: this.phone.lookupVariants(vinculo.spousePhone) } },
          });
          if (!conyuge) {
            result.errors.push({
              row: vinculo.row,
              message:
                `No hay ningún participante con el teléfono del cónyuge ` +
                `(${vinculo.spousePhone}). Inclúyelo en el archivo o anota solo su nombre`,
              label: rowLabel(vinculo.data),
              data: vinculo.data,
            });
            continue;
          }

          await this.participants.updateMarital({
            participantId: persona.id,
            maritalStatus: MaritalStatus.CASADO,
            spouseParticipantId: conyuge.id,
            actorId: options.actorId ?? null,
          });
        } else {
          await this.participants.updateMarital({
            participantId: persona.id,
            maritalStatus: MaritalStatus.CASADO,
            spouseName: vinculo.spouseName ?? null,
            actorId: options.actorId ?? null,
          });
        }
      } catch (error) {
        // Un conflicto de matrimonio (alguien ya casado con un tercero) se
        // reporta en su fila y no interrumpe el resto del archivo.
        result.errors.push({
          row: vinculo.row,
          message: error instanceof Error ? error.message : 'No se pudo registrar el cónyuge',
          label: rowLabel(vinculo.data),
          data: vinculo.data,
        });
      }
    }
  }

  /**
   * Asignaciones fijas (el turno habitual de cada quien).
   * Columnas: `telefono`, `dia`, `inicio`, y opcionalmente `semana`
   * (`0` o vacío = todas las semanas; `1` a `5` = ordinal del mes, para sábado y domingo).
   */
  async importRecurringAssignments(csv: string, options: ImportOptions): Promise<ImportResult> {
    const result = emptyResult(options.dryRun ?? false);
    const rows = this.parseCsv(csv, result, ASSIGNMENT_COLUMNS);
    if (rows.length === 0) return result;

    // Primero se lee y valida el formato de todo el archivo sin tocar la base:
    // lo que está mal escrito no necesita ninguna consulta para saberse mal.
    const leidas: FilaAsignacion[] = [];

    for (const [index, row] of rows.entries()) {
      const rowNumber = index + 2;
      result.processed += 1;

      const rawPhone = (row.telefono ?? row.teléfono ?? row.phone ?? '').trim();
      const dayRaw = (row.dia ?? row.día ?? row.day ?? '').trim().toLowerCase();
      const startRaw = (row.inicio ?? row.hora ?? row.start ?? '').trim();
      const weekRaw = (row.semana ?? row.week ?? '').trim();

      const phoneE164 = rawPhone ? this.phone.tryNormalize(rawPhone) : null;
      if (!phoneE164) {
        result.errors.push({
          row: rowNumber,
          message: `Teléfono inválido o ausente: "${rawPhone}"`,
          label: rowLabel(row),
          data: row,
        });
        continue;
      }

      const weekday = WEEKDAY_BY_NAME[dayRaw];
      if (weekday === undefined) {
        result.errors.push({
          row: rowNumber,
          message: `Día desconocido "${dayRaw}". Usa lunes, martes, ... domingo`,
          label: rowLabel(row),
          data: row,
        });
        continue;
      }

      const startMinute = this.parseTime(startRaw);
      if (startMinute === null) {
        result.errors.push({
          row: rowNumber,
          message: `Hora de inicio inválida "${startRaw}". Usa formato 7:00`,
          label: rowLabel(row),
          data: row,
        });
        continue;
      }

      const weekOfMonth = weekRaw === '' ? 0 : Number(weekRaw);
      if (!Number.isInteger(weekOfMonth) || weekOfMonth < 0 || weekOfMonth > 5) {
        result.errors.push({
          row: rowNumber,
          message: `Semana inválida "${weekRaw}". Usa 0 (todas) o 1 a 5`,
          label: rowLabel(row),
          data: row,
        });
        continue;
      }

      leidas.push({
        rowNumber,
        phoneE164,
        rawPhone,
        weekday,
        startMinute,
        weekOfMonth,
        dayRaw,
        startRaw,
        data: row,
      });
    }

    if (leidas.length > 0) {
      await this.writeRecurringAssignments(leidas, result, options);
    }

    await this.recordAudit('recurring-assignments', result, options);
    return result;
  }

  /**
   * Resuelve y escribe las asignaciones leídas con un puñado de consultas.
   *
   * Antes cada fila hacía cinco viajes a la base —buscar a la persona, buscar la
   * franja, buscar la asignación previa, contar titulares y escribir—, así que un
   * archivo con dos franjas por participante sumaba más de mil viajes. Contra una
   * base remota eso tardaba más de dos minutos y el proxy cortaba la petición: el
   * navegador veía un error aunque el servidor siguiera trabajando. Es el mismo
   * problema que tuvo la importación del padrón, y se resuelve igual: se precarga
   * lo que hace falta de una vez y se resuelve en memoria.
   */
  private async writeRecurringAssignments(
    leidas: FilaAsignacion[],
    result: ImportResult,
    options: ImportOptions,
  ): Promise<void> {
    const variantes = [
      ...new Set(leidas.flatMap((fila) => this.phone.lookupVariants(fila.phoneE164))),
    ];

    const [personas, plantillas] = await Promise.all([
      this.prisma.participant.findMany({
        where: { phoneE164: { in: variantes } },
        select: {
          id: true,
          phoneE164: true,
          // El nombre no se usa para resolver nada: es para que un error diga de
          // quién es la fila. En un archivo de cientos de renglones, un teléfono
          // suelto obliga a buscar a quién pertenece antes de poder corregirlo.
          firstName: true,
          paternalSurname: true,
          maternalSurname: true,
        },
      }),
      this.prisma.shiftTemplate.findMany({
        where: { locationId: options.locationId, active: true },
        select: { id: true, weekday: true, startMinute: true, weekOfMonth: true, capacity: true },
      }),
    ]);

    const porTelefono = new Map<string, (typeof personas)[number]>();
    for (const persona of personas) {
      for (const variante of this.phone.lookupVariants(persona.phoneE164)) {
        porTelefono.set(variante, persona);
      }
    }

    /** Quién es esa fila: «López Pérez, Ana · 55 1234 5678». */
    const etiqueta = (fila: FilaAsignacion): string => {
      const persona = porTelefono.get(fila.phoneE164);
      return persona ? `${formalName(persona)} · ${fila.rawPhone}` : rowLabel(fila.data);
    };

    const porFranja = new Map(plantillas.map((plantilla) => [franjaKey(plantilla), plantilla]));

    const previas = await this.prisma.recurringAssignment.findMany({
      where: { shiftTemplateId: { in: plantillas.map((plantilla) => plantilla.id) } },
      select: { id: true, shiftTemplateId: true, participantId: true, active: true },
    });

    const porPareja = new Map(
      previas.map((previa) => [`${previa.shiftTemplateId}:${previa.participantId}`, previa]),
    );

    // Titulares que ya ocupan lugar, para comprobar el cupo sin volver a contar
    // en la base por cada fila.
    const titulares = new Map<string, number>();
    for (const previa of previas) {
      if (!previa.active) continue;
      titulares.set(previa.shiftTemplateId, (titulares.get(previa.shiftTemplateId) ?? 0) + 1);
    }

    const aCrear: Array<{ shiftTemplateId: string; participantId: string }> = [];
    const aReactivar: string[] = [];
    // Parejas que esta corrida deja activas, para que una fila repetida dentro
    // del mismo archivo cuente como actualización y no duplique.
    const resueltas = new Set<string>();

    for (const fila of leidas) {
      const persona = porTelefono.get(fila.phoneE164);
      if (!persona) {
        result.errors.push({
          row: fila.rowNumber,
          message: `No hay ningún participante con el teléfono ${fila.rawPhone}. Impórtalo primero`,
          label: rowLabel(fila.data),
          data: fila.data,
        });
        continue;
      }
      const participantId = persona.id;

      const plantilla = porFranja.get(franjaKey(fila));
      if (!plantilla) {
        result.errors.push({
          row: fila.rowNumber,
          message:
            `No existe un turno de ${fila.dayRaw} a las ${fila.startRaw}` +
            `${fila.weekOfMonth ? ` (semana ${fila.weekOfMonth})` : ''}`,
          label: etiqueta(fila),
          data: fila.data,
        });
        continue;
      }

      const pareja = `${plantilla.id}:${participantId}`;
      const previa = porPareja.get(pareja);

      // Una fila que repite lo que ya existe —o lo que otra fila del mismo
      // archivo acaba de resolver— es una actualización, no un duplicado.
      if (previa || resueltas.has(pareja)) {
        result.updated += 1;
        if (previa && !previa.active && !aReactivar.includes(previa.id)) {
          aReactivar.push(previa.id);
          titulares.set(plantilla.id, (titulares.get(plantilla.id) ?? 0) + 1);
        }
        resueltas.add(pareja);
        continue;
      }

      const ocupados = titulares.get(plantilla.id) ?? 0;
      if (ocupados >= plantilla.capacity) {
        result.errors.push({
          row: fila.rowNumber,
          message:
            `El turno de ${fila.dayRaw} a las ${fila.startRaw} ya tiene ${ocupados} titulares ` +
            `para ${plantilla.capacity} lugares`,
          label: etiqueta(fila),
          data: fila.data,
        });
        continue;
      }

      aCrear.push({ shiftTemplateId: plantilla.id, participantId });
      titulares.set(plantilla.id, ocupados + 1);
      resueltas.add(pareja);
      result.created += 1;
    }

    if (result.dryRun) return;

    if (aCrear.length > 0) {
      await this.prisma.recurringAssignment.createMany({ data: aCrear, skipDuplicates: true });
    }
    if (aReactivar.length > 0) {
      await this.prisma.recurringAssignment.updateMany({
        where: { id: { in: aReactivar } },
        data: { active: true },
      });
    }
  }

  /**
   * Lee el archivo y normaliza los nombres de columna.
   *
   * El separador se detecta entre coma, punto y coma y tabulador: Excel en
   * español guarda los CSV con punto y coma, y al suponer solo la coma el
   * encabezado completo se convertía en una única columna. El resultado era que
   * todas las filas fallaban con «Falta el nombre», sin pista de la causa real.
   *
   * `columnas` son los nombres que ese importador entiende; si el encabezado no
   * trae ninguno, se reporta de una vez en lugar de dejar que cada fila se queje
   * por separado de un campo que en realidad nunca se leyó.
   */
  private parseCsv(
    csv: string,
    result: ImportResult,
    columnas: readonly string[],
  ): Array<Record<string, string>> {
    let rows: Array<Record<string, string>>;

    try {
      rows = parse(csv, {
        columns: (header: string[]) => header.map((column) => column.trim().toLowerCase()),
        delimiter: [',', ';', '\t'],
        skip_empty_lines: true,
        trim: true,
        bom: true,
        relaxColumnCount: true,
      }) as Array<Record<string, string>>;
    } catch (error) {
      result.errors.push({
        row: 1,
        message: `No se pudo leer el archivo: ${error instanceof Error ? error.message : String(error)}`,
      });
      return [];
    }

    if (rows.length === 0) {
      result.errors.push({
        row: 1,
        message: 'El archivo no tiene filas de datos, solo el encabezado',
      });
      return [];
    }

    const encabezado = Object.keys(rows[0]);
    const reconocidas = encabezado.filter((columna) => columnas.includes(columna));

    if (reconocidas.length === 0) {
      result.errors.push({
        row: 1,
        message:
          `No se reconoció ninguna columna. Se encontró: ${encabezado.map((c) => `«${c}»`).join(', ')}. ` +
          `Se esperaba al menos una de: ${columnas.join(', ')}. ` +
          'Revisa que la primera fila sea el encabezado y que el archivo esté separado por comas, ' +
          'punto y coma o tabuladores.',
      });
      return [];
    }

    return rows;
  }

  /** Acepta "7:00", "7", "07:30". */
  private parseTime(value: string): number | null {
    const match = /^(\d{1,2})(?::(\d{2}))?$/.exec(value);
    if (!match) return null;

    const hour = Number(match[1]);
    const minute = match[2] ? Number(match[2]) : 0;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

    return hour * 60 + minute;
  }

  private async recordAudit(
    kind: string,
    result: ImportResult,
    options: ImportOptions,
  ): Promise<void> {
    if (result.dryRun) return;

    await this.audit.record({
      actorType: options.actorId ? ActorType.ADMIN : ActorType.SYSTEM,
      actorId: options.actorId ?? null,
      action: AUDIT_ACTIONS.IMPORT_RUN,
      entity: 'Location',
      entityId: options.locationId,
      metadata: {
        tipo: kind,
        procesadas: result.processed,
        creadas: result.created,
        actualizadas: result.updated,
        errores: result.errors.length,
      },
    });

    this.logger.log(
      `Importación de ${kind}: ${result.created} creada(s), ${result.updated} actualizada(s), ` +
        `${result.errors.length} error(es)`,
    );
  }
}
