import { Body, Controller, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { MaritalStatus, ParticipantStatus } from '@prisma/client';
import { CsvImportService } from '../import/csv-import.service';
import { ROLE_BY_NAME } from '../import/import.types';
import {
  ORGANIZATION_FIELDS,
  OrganizationField,
  OrganizationFieldsService,
} from '../participants/organization-fields.service';
import { ParticipantDirectoryService } from '../participants/participant-directory.service';
import { ParticipantProfileService } from '../participants/participant-profile.service';
import { ParticipantsService } from '../participants/participants.service';
import { ReportsService } from '../reports/reports.service';
import { AdminAuthGuard, SoloAdmin } from './admin-auth.guard';
import {
  CreateParticipantDto,
  ImportDto,
  UpdateMaritalDto,
  UpdateOrganizationDto,
  UpdateParticipantDto,
} from './admin.dto';
import { AdminTokenPayload } from './auth.service';
import { CurrentAdmin } from './current-admin.decorator';

/** El padrón del punto: consulta, alta, edición e importación. */
@Controller('api/admin')
export class AdminParticipantsController {
  constructor(
    private readonly directory: ParticipantDirectoryService,
    private readonly profiles: ParticipantProfileService,
    private readonly participants: ParticipantsService,
    private readonly organization: OrganizationFieldsService,
    private readonly reports: ReportsService,
    private readonly importer: CsvImportService,
  ) {}

  @Get('locations/:id/participants')
  @UseGuards(AdminAuthGuard)
  participantsOf(@Param('id') id: string) {
    return this.directory.listByLocation(id);
  }

  /**
   * Edición de un participante desde el Padrón.
   *
   * El punto va en la ruta porque el rol y la preferencia de avisos son del
   * vínculo, no de la persona: sin saber de qué punto se habla no se puede
   * resolver cuál membresía tocar.
   *
   * Devuelve la fila con la misma forma que el padrón, más lo que el diálogo
   * necesita contar: cuántos turnos se liberaron y los avisos que no impidieron
   * guardar pero conviene leer.
   */
  @Patch('locations/:id/participants/:participantId')
  @UseGuards(AdminAuthGuard)
  async updateParticipant(
    @Param('id') id: string,
    @Param('participantId') participantId: string,
    @Body() dto: UpdateParticipantDto,
    @CurrentAdmin() admin: AdminTokenPayload,
  ) {
    const { cancelledShifts, removedFixedShifts, warnings } = await this.profiles.updateProfile({
      participantId,
      locationId: id,
      firstName: dto.firstName,
      paternalSurname: dto.paternalSurname,
      maternalSurname: dto.maternalSurname,
      displayName: dto.displayName,
      phone: dto.phone,
      role: dto.role ? ROLE_BY_NAME[dto.role.toLowerCase()] : undefined,
      coverageAlerts: dto.coverageAlerts,
      status: dto.status ? ParticipantStatus[dto.status] : undefined,
      congregation: dto.congregation,
      circuit: dto.circuit,
      city: dto.city,
      maritalStatus: dto.maritalStatus ? MaritalStatus[dto.maritalStatus] : undefined,
      spouseParticipantId: dto.spouseParticipantId,
      spouseName: dto.spouseName,
      actorId: admin.sub,
      actorName: admin.name,
    });

    const row = await this.directory.rowFor(participantId, id);

    return { ...row, cancelledShifts, removedFixedShifts, warnings };
  }

  /** Estado civil y cónyuge de un participante. */
  @Patch('participants/:participantId/marital')
  @UseGuards(AdminAuthGuard)
  updateMarital(
    @Param('participantId') participantId: string,
    @Body() dto: UpdateMaritalDto,
    @CurrentAdmin() admin: AdminTokenPayload,
  ) {
    return this.participants.updateMarital({
      participantId,
      maritalStatus: dto.maritalStatus,
      spouseParticipantId: dto.spouseParticipantId,
      spouseName: dto.spouseName,
      actorId: admin.sub,
      actorName: admin.name,
    });
  }

  /** Congregación, circuito y ciudad de un participante. */
  @Patch('participants/:participantId/organization')
  @UseGuards(AdminAuthGuard)
  updateOrganization(
    @Param('participantId') participantId: string,
    @Body() dto: UpdateOrganizationDto,
    @CurrentAdmin() admin: AdminTokenPayload,
  ) {
    return this.participants.updateOrganization(participantId, dto, {
      id: admin.sub,
      name: admin.name,
    });
  }

  /**
   * Valores ya registrados en los tres campos, para sugerirlos al capturar y
   * para armar los filtros del padrón.
   */
  @Get('locations/:id/organization-values')
  @UseGuards(AdminAuthGuard)
  async organizationValues(@Param('id') id: string) {
    const entradas = await Promise.all(
      ORGANIZATION_FIELDS.map(
        async (campo) => [campo, await this.organization.knownValues(campo, id)] as const,
      ),
    );
    return Object.fromEntries(entradas) as Record<OrganizationField, string[]>;
  }

  /** Cuánta gente hay por congregación, circuito o ciudad. */
  @Get('locations/:id/organization-report')
  @UseGuards(AdminAuthGuard)
  async organizationReport(@Param('id') id: string) {
    const entradas = await Promise.all(
      ORGANIZATION_FIELDS.map(
        async (campo) => [campo, await this.organization.countByField(campo, id)] as const,
      ),
    );
    return Object.fromEntries(entradas);
  }

  /**
   * «¿Qué turnos cubre tal persona?»: sus turnos fijos y las fechas que ya
   * tiene registradas de hoy en adelante, sustituciones incluidas.
   */
  @Get('locations/:id/participants/:participantId/shifts')
  @UseGuards(AdminAuthGuard)
  participantShifts(@Param('id') id: string, @Param('participantId') participantId: string) {
    return this.reports.participantShifts(id, participantId);
  }

  /** Participantes del punto que pueden figurar como cónyuge. */
  @Get('locations/:id/participants/:participantId/spouse-candidates')
  @UseGuards(AdminAuthGuard)
  spouseCandidates(@Param('id') id: string, @Param('participantId') participantId: string) {
    return this.participants.spouseCandidates(participantId, id);
  }

  @Post('locations/:id/participants')
  @UseGuards(AdminAuthGuard)
  createParticipant(@Param('id') id: string, @Body() dto: CreateParticipantDto) {
    const role = dto.role ? ROLE_BY_NAME[dto.role.toLowerCase()] : undefined;
    return this.participants.create({
      firstName: dto.firstName,
      paternalSurname: dto.paternalSurname,
      maternalSurname: dto.maternalSurname,
      displayName: dto.displayName,
      congregation: dto.congregation,
      circuit: dto.circuit,
      city: dto.city,
      phone: dto.phone,
      locationId: id,
      role: role,
    });
  }

  @Post('locations/:id/import/participants')
  @UseGuards(AdminAuthGuard)
  @SoloAdmin()
  @HttpCode(200)
  importParticipants(@Param('id') id: string, @Body() dto: ImportDto) {
    return this.importer.importParticipants(dto.csv, {
      locationId: id,
      dryRun: dto.dryRun ?? false,
    });
  }

  @Post('locations/:id/import/assignments')
  @UseGuards(AdminAuthGuard)
  @SoloAdmin()
  @HttpCode(200)
  importAssignments(@Param('id') id: string, @Body() dto: ImportDto) {
    return this.importer.importRecurringAssignments(dto.csv, {
      locationId: id,
      dryRun: dto.dryRun ?? false,
    });
  }
}
