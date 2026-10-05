import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { displayName, PADRON_ORDER } from '../common/names/person-name';
import { SettingsService } from '../common/settings/settings.service';
import { CsvImportService } from '../import/csv-import.service';
import { ParticipantsService } from '../participants/participants.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReportsService } from '../reports/reports.service';
import { ScheduleGeneratorService } from '../scheduling/schedule-generator.service';
import { AdminAuthGuard } from './admin-auth.guard';
import {
  AssignParticipantDto,
  CancelAssignmentDto,
  CreateParticipantDto,
  CreateWindowDto,
  UpdateMaritalDto,
  UpdateOrganizationDto,
  ImportDto,
  LoginDto,
  MonthQueryDto,
  PollDraftQueryDto,
  RangeQueryDto,
  UpdateSettingsDto,
} from './admin.dto';
import { AdminAuthService, AdminTokenPayload } from './auth.service';
import { CurrentAdmin } from './current-admin.decorator';
import { SupervisorsService } from '../supervisors/supervisors.service';
import {
  ORGANIZATION_FIELDS,
  OrganizationField,
  OrganizationFieldsService,
} from '../participants/organization-fields.service';
import { AssignmentsService } from '../scheduling/assignments.service';
import { PollDraftService } from '../reports/poll-draft.service';
import { ActorType } from '@prisma/client';
import { ROLE_BY_NAME } from '../import/import.types';

@Controller('api/admin')
export class AdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AdminAuthService,
    private readonly settings: SettingsService,
    private readonly importer: CsvImportService,
    private readonly reports: ReportsService,
    private readonly generator: ScheduleGeneratorService,
    private readonly participants: ParticipantsService,
    private readonly supervisors: SupervisorsService,
    private readonly assignments: AssignmentsService,
    private readonly pollDraft_: PollDraftService,
    private readonly organization: OrganizationFieldsService,
  ) {}

  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  @Get('locations')
  @UseGuards(AdminAuthGuard)
  locations() {
    return this.prisma.location.findMany({ orderBy: { name: 'asc' } });
  }

  @Get('locations/:id/calendar')
  @UseGuards(AdminAuthGuard)
  calendar(@Param('id') id: string, @Query() query: MonthQueryDto) {
    return this.reports.monthCalendar(id, query.year, query.month);
  }

  @Post('locations/:id/calendar/generate')
  @UseGuards(AdminAuthGuard)
  generate(@Param('id') id: string, @Body() body: MonthQueryDto) {
    return this.generator.generateMonth(id, body.year, body.month);
  }

  @Get('locations/:id/participants')
  @UseGuards(AdminAuthGuard)
  async participantsOf(@Param('id') id: string) {
    return this.prisma.participant.findMany({
      where: { memberships: { some: { locationId: id, active: true } } },
      orderBy: [...PADRON_ORDER],
      select: {
        id: true,
        firstName: true,
        paternalSurname: true,
        maternalSurname: true,
        displayName: true,
        phoneE164: true,
        role: true,
        status: true,
        coverageAlerts: true,
        optInAt: true,
        maritalStatus: true,
        congregation: true,
        circuit: true,
        city: true,
        spouseName: true,
        spouse: {
          select: {
            id: true,
            firstName: true,
            paternalSurname: true,
            maternalSurname: true,
            displayName: true,
          },
        },
      },
    });
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
  @HttpCode(200)
  importParticipants(@Param('id') id: string, @Body() dto: ImportDto) {
    return this.importer.importParticipants(dto.csv, {
      locationId: id,
      dryRun: dto.dryRun ?? false,
    });
  }

  @Post('locations/:id/import/assignments')
  @UseGuards(AdminAuthGuard)
  @HttpCode(200)
  importAssignments(@Param('id') id: string, @Body() dto: ImportDto) {
    return this.importer.importRecurringAssignments(dto.csv, {
      locationId: id,
      dryRun: dto.dryRun ?? false,
    });
  }

  /** Encargados del punto con sus franjas de guardia y su estado actual. */
  @Get('locations/:id/supervisors')
  @UseGuards(AdminAuthGuard)
  async supervisorsOf(@Param('id') id: string) {
    const supervisors = await this.supervisors.allSupervisors(id);
    const onDuty = new Set((await this.supervisors.onDutyNow(id)).map((item) => item.id));

    return Promise.all(
      supervisors.map(async (supervisor) => {
        const status = await this.supervisors.dutyStatus(supervisor.id, id);
        return {
          id: supervisor.id,
          fullName: displayName(supervisor),
          phoneE164: supervisor.phoneE164,
          onDuty: onDuty.has(supervisor.id),
          overrideActive: status.overrideActive,
          available: status.presence?.available ?? null,
          windows: status.windows.map((window) => ({
            id: window.id,
            weekday: window.weekday,
            startMinute: window.startMinute,
            endMinute: window.endMinute,
          })),
        };
      }),
    );
  }

  @Post('locations/:id/supervisors/:participantId/windows')
  @UseGuards(AdminAuthGuard)
  addWindow(
    @Param('id') id: string,
    @Param('participantId') participantId: string,
    @Body() dto: CreateWindowDto,
  ) {
    return this.supervisors.addWindow(
      participantId,
      id,
      dto.weekday,
      dto.startMinute,
      dto.endMinute,
    );
  }

  @Delete('supervisors/windows/:windowId')
  @UseGuards(AdminAuthGuard)
  @HttpCode(204)
  removeWindow(@Param('windowId') windowId: string) {
    return this.supervisors.removeWindow(windowId);
  }

  // -------------------------------------------------------------------------
  // Tablero operativo
  // -------------------------------------------------------------------------

  @Get('locations/:id/dashboard')
  @UseGuards(AdminAuthGuard)
  dashboard(@Param('id') id: string, @Query() query: RangeQueryDto) {
    return this.reports.dashboard(id, new Date(query.from), new Date(query.to));
  }

  /** Da de baja a un participante de un turno. La baja se aplica de inmediato. */
  @Post('assignments/:assignmentId/cancel')
  @UseGuards(AdminAuthGuard)
  @HttpCode(200)
  async cancelAssignment(
    @Param('assignmentId') assignmentId: string,
    @Body() dto: CancelAssignmentDto,
    @CurrentAdmin() admin: AdminTokenPayload,
  ) {
    await this.assignments.cancel({
      assignmentId,
      actorId: admin.sub,
      actorType: ActorType.ADMIN,
      actorName: admin.name,
      reason: dto.reason,
      reasonCode: dto.reasonCode,
    });
    return { ok: true };
  }

  /** Registra a quien se ofreció en el grupo tras la encuesta. */
  @Post('locations/:id/shifts/:shiftId/assignments')
  @UseGuards(AdminAuthGuard)
  @HttpCode(201)
  async assignParticipant(
    @Param('shiftId') shiftId: string,
    @Body() dto: AssignParticipantDto,
    @CurrentAdmin() admin: AdminTokenPayload,
  ) {
    await this.assignments.assignManually({
      shiftId,
      participantId: dto.participantId,
      actorId: admin.sub,
      actorName: admin.name,
      actorType: ActorType.ADMIN,
    });
    return { ok: true };
  }

  /** Quiénes pueden tomar ese turno, para el selector del tablero. */
  @Get('locations/:id/shifts/:shiftId/available-participants')
  @UseGuards(AdminAuthGuard)
  availableParticipants(@Param('id') id: string, @Param('shiftId') shiftId: string) {
    return this.prisma.participant.findMany({
      where: {
        status: 'ACTIVE',
        memberships: { some: { locationId: id, active: true } },
        // Quien ya ocupa un lugar en ese turno no puede volver a tomarlo.
        NOT: {
          assignments: {
            some: { shiftId, status: { in: ['ASSIGNED', 'CONFIRMED'] } },
          },
        },
      },
      select: {
        id: true,
        firstName: true,
        paternalSurname: true,
        maternalSurname: true,
        displayName: true,
        role: true,
      },
      orderBy: [...PADRON_ORDER],
    });
  }

  /** Movimientos de un turno, incluidas las personas que ya no figuran en él. */
  @Get('shifts/:shiftId/history')
  @UseGuards(AdminAuthGuard)
  shiftHistory(@Param('shiftId') shiftId: string) {
    return this.reports.shiftHistory(shiftId);
  }

  /** Actividad reciente del punto, para la cabecera del tablero. */
  @Get('locations/:id/movements')
  @UseGuards(AdminAuthGuard)
  movements(@Param('id') id: string, @Query('limit') limit?: string) {
    return this.reports.recentMovements(id, limit ? Number(limit) : 20);
  }

  /** Texto listo para copiar a la encuesta del grupo. */
  @Get('locations/:id/poll-draft')
  @UseGuards(AdminAuthGuard)
  pollDraft(@Param('id') id: string, @Query() query: PollDraftQueryDto) {
    return this.pollDraft_.build(
      id,
      new Date(query.from),
      new Date(query.to),
      query.level ?? 'cupo',
    );
  }

  @Get('locations/:id/settings')
  @UseGuards(AdminAuthGuard)
  getSettings(@Param('id') id: string) {
    return this.settings.forLocation(id);
  }

  @Patch('locations/:id/settings')
  @UseGuards(AdminAuthGuard)
  updateSettings(@Param('id') id: string, @Body() dto: UpdateSettingsDto) {
    return this.settings.update(id, dto);
  }

  @Get('locations/:id/reports/monthly')
  @UseGuards(AdminAuthGuard)
  monthly(@Param('id') id: string, @Query() query: MonthQueryDto) {
    return this.reports.monthlySummary(id, query.year, query.month);
  }

  @Get('locations/:id/reports/attendance')
  @UseGuards(AdminAuthGuard)
  attendance(@Param('id') id: string, @Query('from') from: string, @Query('to') to: string) {
    return this.reports.attendance(id, new Date(from), new Date(to));
  }

  @Get('audit')
  @UseGuards(AdminAuthGuard)
  audit(
    @Query('entity') entity?: string,
    @Query('entityId') entityId?: string,
    @Query('action') action?: string,
    @Query('limit') limit?: string,
  ) {
    return this.reports.auditTrail({
      entity,
      entityId,
      action,
      limit: limit ? Number(limit) : undefined,
    });
  }
}
