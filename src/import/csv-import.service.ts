import { Injectable, Logger } from '@nestjs/common';
import { ActorType } from '@prisma/client';
import { parse } from 'csv-parse/sync';
import { AUDIT_ACTIONS, AuditService } from '../audit/audit.service';
import { PhoneService } from '../common/phone/phone.service';
import { PrismaService } from '../prisma/prisma.service';
import { emptyResult, ImportResult, ROLE_BY_NAME, WEEKDAY_BY_NAME } from './import.types';

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
    private readonly audit: AuditService,
  ) {}

  /**
   * Padrón de participantes.
   * Columnas: `nombre`, `telefono`, y opcionalmente `rol` y `alertas`.
   */
  async importParticipants(csv: string, options: ImportOptions): Promise<ImportResult> {
    const result = emptyResult(options.dryRun ?? false);
    const rows = this.parseCsv(csv, result);

    for (const [index, row] of rows.entries()) {
      const rowNumber = index + 2;
      result.processed += 1;

      const fullName = (row.nombre ?? row.name ?? '').trim();
      const rawPhone = (row.telefono ?? row.teléfono ?? row.phone ?? '').trim();

      if (!fullName) {
        result.errors.push({ row: rowNumber, message: 'Falta el nombre', data: row });
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
          data: { fullName, role, coverageAlerts },
        });
        await this.prisma.locationMembership.upsert({
          where: {
            locationId_participantId: {
              locationId: options.locationId,
              participantId: existing.id,
            },
          },
          create: { locationId: options.locationId, participantId: existing.id },
          update: { active: true },
        });
        result.updated += 1;
        continue;
      }

      await this.prisma.participant.create({
        data: {
          fullName,
          phoneE164,
          role,
          coverageAlerts,
          memberships: { create: { locationId: options.locationId } },
        },
      });
      result.created += 1;
    }

    await this.recordAudit('participants', result, options);
    return result;
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
