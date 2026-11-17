import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { SettingsService } from '../common/settings/settings.service';
import { AuditTrailService } from '../reports/audit-trail.service';
import { MonthRosterService } from '../reports/month-roster.service';
import { ReportsService } from '../reports/reports.service';
import { ScheduleGeneratorService } from '../scheduling/schedule-generator.service';
import { AdminAuthGuard, SoloAdmin } from './admin-auth.guard';
import { MonthQueryDto, AuditQueryDto, UpdateLocationDto, UpdateSettingsDto } from './admin.dto';
import { AdminTokenPayload } from './auth.service';
import { CurrentAdmin } from './current-admin.decorator';
import { AdminRole } from '@prisma/client';

/** El punto: su identidad, sus ajustes, el calendario, los reportes y la bitácora. */
@Controller('api/admin')
export class AdminController {
  constructor(
    private readonly settings: SettingsService,
    private readonly reports: ReportsService,
    private readonly monthRoster: MonthRosterService,
    private readonly auditTrail: AuditTrailService,
    private readonly generator: ScheduleGeneratorService,
  ) {}

  @Get('locations')
  @UseGuards(AdminAuthGuard)
  locations() {
    return this.settings.listLocations();
  }

  @Get('locations/:id/calendar')
  @UseGuards(AdminAuthGuard)
  calendar(@Param('id') id: string, @Query() query: MonthQueryDto) {
    return this.reports.monthCalendar(id, query.year, query.month);
  }

  @Get('locations/:id/roster')
  @UseGuards(AdminAuthGuard)
  roster(@Param('id') id: string, @Query() query: MonthQueryDto) {
    return this.monthRoster.monthRoster(id, query.year, query.month);
  }

  @Post('locations/:id/calendar/generate')
  @UseGuards(AdminAuthGuard)
  generate(@Param('id') id: string, @Body() body: MonthQueryDto) {
    return this.generator.generateMonth(id, body.year, body.month);
  }

  /** Nombre y dirección del punto: la cabecera del panel y el mensaje del grupo. */
  @Patch('locations/:id')
  @UseGuards(AdminAuthGuard)
  @SoloAdmin()
  updateLocation(@Param('id') id: string, @Body() dto: UpdateLocationDto) {
    return this.settings.updateIdentity(id, dto);
  }

  @Get('locations/:id/settings')
  @UseGuards(AdminAuthGuard)
  getSettings(@Param('id') id: string) {
    return this.settings.forLocation(id);
  }

  @Patch('locations/:id/settings')
  @UseGuards(AdminAuthGuard)
  @SoloAdmin()
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

  /**
   * Histórico completo, de lo más reciente hacia atrás.
   *
   * Sin `@SoloAdmin()`: el encargado también consulta la bitácora, y lo que no
   * debe ver —accesos y cuentas— se descarta aquí, según el rol del token, no
   * según lo que el panel decida pintar.
   */
  @Get('audit')
  @UseGuards(AdminAuthGuard)
  audit(@Query() query: AuditQueryDto, @CurrentAdmin() admin: AdminTokenPayload) {
    return this.auditTrail.auditHistory({
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      categoria: query.categoria,
      persona: query.persona,
      cursor: query.cursor,
      limit: query.limit ?? 50,
      verSensibles: admin.role === AdminRole.ADMIN,
    });
  }
}
