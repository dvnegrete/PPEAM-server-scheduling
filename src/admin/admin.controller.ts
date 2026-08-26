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
import { SettingsService } from '../common/settings/settings.service';
import { CsvImportService } from '../import/csv-import.service';
import { ParticipantsService } from '../participants/participants.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReportsService } from '../reports/reports.service';
import { ScheduleGeneratorService } from '../scheduling/schedule-generator.service';
import { AdminAuthGuard } from './admin-auth.guard';
import {
  CreateParticipantDto,
  CreateWindowDto,
  ImportDto,
  LoginDto,
  MonthQueryDto,
  UpdateSettingsDto,
} from './admin.dto';
import { AdminAuthService } from './auth.service';
import { SupervisorsService } from '../supervisors/supervisors.service';
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
      orderBy: { fullName: 'asc' },
      select: {
        id: true,
        fullName: true,
        phoneE164: true,
        role: true,
        status: true,
        coverageAlerts: true,
        optInAt: true,
      },
    });
  }

  @Post('locations/:id/participants')
  @UseGuards(AdminAuthGuard)
  createParticipant(@Param('id') id: string, @Body() dto: CreateParticipantDto) {
    const role = dto.role ? ROLE_BY_NAME[dto.role.toLowerCase()] : undefined;
    return this.participants.create({
      fullName: dto.fullName,
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
          fullName: supervisor.fullName,
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
