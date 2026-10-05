import { Injectable, Logger } from '@nestjs/common';
import { ActorType, MaritalStatus } from '@prisma/client';
import { parse } from 'csv-parse/sync';
import { AUDIT_ACTIONS, AuditService } from '../audit/audit.service';
import { PhoneService } from '../common/phone/phone.service';
import { TimeService } from '../common/time/time.service';
import { MembershipsService } from '../participants/memberships.service';
import { OrganizationFieldsService } from '../participants/organization-fields.service';
import { ParticipantsService } from '../participants/participants.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  emptyResult,
  ImportResult,
  MARITAL_BY_NAME,
  ROLE_BY_NAME,
  SpouseLink,
  WEEKDAY_BY_NAME,
} from './import.types';

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
    private readonly memberships: MembershipsService,
  ) {}

  /**
   * Padrón de participantes.
   * Columnas: `nombre`, `telefono`, y opcionalmente `rol`, `alertas` y `consentimiento`.
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
    const rows = this.parseCsv(csv, result);
    const vinculos: SpouseLink[] = [];

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
        result.errors.push({ row: rowNumber, message: 'Falta el nombre', data: row });
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
          data: row,
        });
        continue;
      }
      if (!rawPhone) {
        result.errors.push({ row: rowNumber, message: 'Falta el teléfono', data: row });
        continue;
      }

      const phoneE164 = this.phone.tryNormalize(rawPhone);
      if (!phoneE164) {
        result.errors.push({
          row: rowNumber,
          message: `El teléfono "${rawPhone}" no es válido`,
          data: row,
        });
        continue;
      }

      const roleRaw = (row.rol ?? row.role ?? '').trim().toLowerCase();
      if (roleRaw && !ROLE_BY_NAME[roleRaw]) {
        result.errors.push({
          row: rowNumber,
          message: `Rol desconocido "${roleRaw}". Usa participante, encargado o admin`,
          data: row,
        });
        continue;
      }
      const role = ROLE_BY_NAME[roleRaw] ?? 'PARTICIPANT';

      const alertsRaw = (row.alertas ?? row.alerts ?? '').trim().toLowerCase();
      const coverageAlerts = alertsRaw === '' ? true : !['no', 'false', '0'].includes(alertsRaw);

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
      const organizacion = await this.organization.canonicalAll({
        congregation: congregacion,
        circuit: circuito,
        city: ciudad,
      });

      const civilRaw = (row.estado_civil ?? row['estado civil'] ?? '').trim().toLowerCase();
      if (civilRaw && !MARITAL_BY_NAME[civilRaw]) {
        result.errors.push({
          row: rowNumber,
          message: `Estado civil desconocido "${civilRaw}". Usa soltero, casado, viudo o separado`,
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
            data: row,
          });
          continue;
        }
        vinculos.push({ row: rowNumber, phoneE164, spousePhone, data: row });
      } else if (spouseNameRaw) {
        vinculos.push({ row: rowNumber, phoneE164, spouseName: spouseNameRaw, data: row });
      }

      if (options.dryRun) {
        const exists = await this.prisma.participant.findFirst({
          where: { phoneE164: { in: this.phone.lookupVariants(phoneE164) } },
        });
        if (exists) result.updated += 1;
        else result.created += 1;
        continue;
      }

      const existing = await this.prisma.participant.findFirst({
        where: { phoneE164: { in: this.phone.lookupVariants(phoneE164) } },
      });

      if (existing) {
        await this.prisma.participant.update({
          where: { id: existing.id },
          data: {
            firstName,
            paternalSurname,
            maternalSurname: maternalSurname || null,
            ...(displayNameRaw ? { displayName: displayNameRaw } : {}),
            // Una columna vacía no borra un dato ya capturado a mano.
            ...(congregacion ? { congregation: organizacion.congregation } : {}),
            ...(circuito ? { circuit: organizacion.circuit } : {}),
            ...(ciudad ? { city: organizacion.city } : {}),
            // Un consentimiento ya registrado no se sobrescribe con la fecha de
            // una reimportación: interesa cuándo se obtuvo por primera vez.
            optInAt: hasConsent ? (existing.optInAt ?? this.time.now()) : null,
            // Una columna vacía no borra un estado civil ya capturado a mano.
            ...(civilRaw ? { maritalStatus } : {}),
          },
        });
        // El rol y la preferencia de avisos son del vínculo con este punto: si la
        // persona atiende otro, allá conserva los suyos.
        await this.memberships.join(existing.id, options.locationId, { role, coverageAlerts });
        result.updated += 1;
        continue;
      }

      const creado = await this.prisma.participant.create({
        data: {
          firstName,
          paternalSurname,
          maternalSurname: maternalSurname || null,
          displayName: displayNameRaw || null,
          ...organizacion,
          phoneE164,
          optInAt: hasConsent ? this.time.now() : null,
          maritalStatus,
        },
      });
      await this.memberships.join(creado.id, options.locationId, { role, coverageAlerts });
      result.created += 1;
    }

    await this.resolveSpouseLinks(vinculos, result, options);
    await this.recordAudit('participants', result, options);
    return result;
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
    const rows = this.parseCsv(csv, result);

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
          data: row,
        });
        continue;
      }

      const weekday = WEEKDAY_BY_NAME[dayRaw];
      if (weekday === undefined) {
        result.errors.push({
          row: rowNumber,
          message: `Día desconocido "${dayRaw}". Usa lunes, martes, ... domingo`,
          data: row,
        });
        continue;
      }

      const startMinute = this.parseTime(startRaw);
      if (startMinute === null) {
        result.errors.push({
          row: rowNumber,
          message: `Hora de inicio inválida "${startRaw}". Usa formato 7:00`,
          data: row,
        });
        continue;
      }

      const weekOfMonth = weekRaw === '' ? 0 : Number(weekRaw);
      if (!Number.isInteger(weekOfMonth) || weekOfMonth < 0 || weekOfMonth > 5) {
        result.errors.push({
          row: rowNumber,
          message: `Semana inválida "${weekRaw}". Usa 0 (todas) o 1 a 5`,
          data: row,
        });
        continue;
      }

      const participant = await this.prisma.participant.findFirst({
        where: { phoneE164: { in: this.phone.lookupVariants(phoneE164) } },
      });
      if (!participant) {
        result.errors.push({
          row: rowNumber,
          message: `No hay ningún participante con el teléfono ${rawPhone}. Impórtalo primero`,
          data: row,
        });
        continue;
      }

      const template = await this.prisma.shiftTemplate.findUnique({
        where: {
          locationId_weekday_startMinute_weekOfMonth: {
            locationId: options.locationId,
            weekday,
            startMinute,
            weekOfMonth,
          },
        },
      });
      if (!template) {
        result.errors.push({
          row: rowNumber,
          message: `No existe un turno de ${dayRaw} a las ${startRaw}${weekOfMonth ? ` (semana ${weekOfMonth})` : ''}`,
          data: row,
        });
        continue;
      }

      const existing = await this.prisma.recurringAssignment.findUnique({
        where: {
          shiftTemplateId_participantId: {
            shiftTemplateId: template.id,
            participantId: participant.id,
          },
        },
      });

      if (options.dryRun) {
        if (existing) result.updated += 1;
        else result.created += 1;
        continue;
      }

      // Comprobación de cupo: sentar más titulares que lugares deja el turno
      // permanentemente lleno y sin espacio para coberturas.
      const current = await this.prisma.recurringAssignment.count({
        where: { shiftTemplateId: template.id, active: true },
      });
      if (!existing && current >= template.capacity) {
        result.errors.push({
          row: rowNumber,
          message:
            `El turno de ${dayRaw} a las ${startRaw} ya tiene ${current} titulares ` +
            `para ${template.capacity} lugares`,
          data: row,
        });
        continue;
      }

      if (existing) {
        await this.prisma.recurringAssignment.update({
          where: { id: existing.id },
          data: { active: true },
        });
        result.updated += 1;
      } else {
        await this.prisma.recurringAssignment.create({
          data: { shiftTemplateId: template.id, participantId: participant.id },
        });
        result.created += 1;
      }
    }

    await this.recordAudit('recurring-assignments', result, options);
    return result;
  }

  private parseCsv(csv: string, result: ImportResult): Array<Record<string, string>> {
    try {
      return parse(csv, {
        columns: (header: string[]) =>
          header.map((column) => column.trim().toLowerCase().replace(/^/, '')),
        skip_empty_lines: true,
        trim: true,
        bom: true,
      }) as Array<Record<string, string>>;
    } catch (error) {
      result.errors.push({
        row: 1,
        message: `No se pudo leer el archivo CSV: ${String(error)}`,
      });
      return [];
    }
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
