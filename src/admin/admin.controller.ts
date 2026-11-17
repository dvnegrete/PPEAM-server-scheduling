import {
  BadRequestException,
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
import { displayName, formalName } from '../common/names/person-name';
import { SettingsService } from '../common/settings/settings.service';
import { ParticipantDirectoryService } from '../participants/participant-directory.service';
import { ParticipantsService } from '../participants/participants.service';
import { ReportsService } from '../reports/reports.service';
import { ScheduleGeneratorService } from '../scheduling/schedule-generator.service';
import { AdminAuthGuard, SoloAdmin } from './admin-auth.guard';
import {
  AnnounceConfirmationsDto,
  AssignParticipantDto,
  SetCaptainDto,
  CancelAssignmentDto,
  ConfirmationsQueryDto,
  CoverShiftDto,
  CreateWindowDto,
  MonthQueryDto,
  AuditQueryDto,
  PollDraftQueryDto,
  RangeQueryDto,
  UpdateLocationDto,
  UpdateSettingsDto,
} from './admin.dto';
import { AdminTokenPayload } from './auth.service';
import { CurrentAdmin } from './current-admin.decorator';
import { SupervisorsService } from '../supervisors/supervisors.service';
import { AssignmentsService } from '../scheduling/assignments.service';
import { ConfirmationsDraftService } from '../reports/confirmations-draft.service';
import { PollDraftService } from '../reports/poll-draft.service';
import { RecurringAssignmentsService } from '../scheduling/recurring-assignments.service';
import { ActorType, AdminRole } from '@prisma/client';

@Controller('api/admin')
export class AdminController {
  constructor(
    private readonly settings: SettingsService,
    private readonly reports: ReportsService,
    private readonly generator: ScheduleGeneratorService,
    private readonly participants: ParticipantsService,
    private readonly supervisors: SupervisorsService,
    private readonly assignments: AssignmentsService,
    private readonly pollDraft_: PollDraftService,
    private readonly confirmations: ConfirmationsDraftService,
    private readonly recurring: RecurringAssignmentsService,
    private readonly directory: ParticipantDirectoryService,
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
    return this.reports.monthRoster(id, query.year, query.month);
  }

  @Post('locations/:id/calendar/generate')
  @UseGuards(AdminAuthGuard)
  generate(@Param('id') id: string, @Body() body: MonthQueryDto) {
    return this.generator.generateMonth(id, body.year, body.month);
  }

  /** Encargados del punto con sus franjas de guardia y su estado actual. */
  @Get('locations/:id/supervisors')
  @UseGuards(AdminAuthGuard)
  supervisorsOf(@Param('id') id: string) {
    return this.supervisors.dutyBoard(id);
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
  // Turnos fijos (quién atiende habitualmente cada franja)
  // -------------------------------------------------------------------------

  /** Las plantillas del punto con sus titulares habituales. */
  @Get('locations/:id/recurring')
  @UseGuards(AdminAuthGuard)
  async recurringSlots(@Param('id') id: string) {
    const [slots, porPersona, padron] = await Promise.all([
      this.recurring.listByLocation(id),
      this.recurring.countByParticipant(id),
      this.directory.namesByLocation(id),
    ]);

    return {
      slots,
      // Quiénes no tienen ningún turno fijo todavía: es lo que falta por
      // capturar y conviene verlo sin tener que recorrer la rejilla.
      padron: padron.map((persona) => ({
        id: persona.id,
        name: displayName(persona),
        formalName: formalName(persona),
        recurringCount: porPersona.get(persona.id) ?? 0,
      })),
    };
  }

  /** Quiénes pueden tomar esa franja como titulares. */
  @Get('locations/:id/recurring/:templateId/candidates')
  @UseGuards(AdminAuthGuard)
  async recurringCandidates(@Param('id') id: string, @Param('templateId') templateId: string) {
    const candidatos = await this.recurring.candidatesFor(templateId, id);
    return candidatos.map((persona) => ({
      id: persona.id,
      name: displayName(persona),
      formalName: formalName(persona),
    }));
  }

  @Post('locations/:id/recurring/:templateId/holders')
  @UseGuards(AdminAuthGuard)
  @HttpCode(201)
  async addRecurringHolder(
    @Param('templateId') templateId: string,
    @Body() dto: AssignParticipantDto,
    @CurrentAdmin() admin: AdminTokenPayload,
  ) {
    await this.recurring.assign(templateId, dto.participantId, {
      id: admin.sub,
      name: admin.name,
    });
    return { ok: true };
  }

  @Delete('recurring/:recurringId')
  @UseGuards(AdminAuthGuard)
  @HttpCode(200)
  async removeRecurringHolder(
    @Param('recurringId') recurringId: string,
    @CurrentAdmin() admin: AdminTokenPayload,
  ) {
    await this.recurring.unassign(recurringId, { id: admin.sub, name: admin.name });
    return { ok: true };
  }

  /** Marca a un titular como capitán del turno (o se lo quita). */
  @Patch('recurring/:recurringId/captain')
  @UseGuards(AdminAuthGuard)
  @HttpCode(200)
  async setRecurringCaptain(
    @Param('recurringId') recurringId: string,
    @Body() dto: SetCaptainDto,
    @CurrentAdmin() admin: AdminTokenPayload,
  ) {
    await this.recurring.setCaptain(recurringId, dto.isCaptain, {
      id: admin.sub,
      name: admin.name,
    });
    return { ok: true };
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
    const params = {
      assignmentId,
      actorId: admin.sub,
      actorType: ActorType.ADMIN,
      actorName: admin.name,
      reason: dto.reason,
      reasonCode: dto.reasonCode,
    };

    // Se devuelve a quién alcanzó la baja para que el panel lo confirme: cuando
    // se cancela a una pareja, decir solo «listo» deja la duda de si el segundo
    // entró o no.
    if (dto.cancelSpouse) {
      const { spouseCancelled } = await this.assignments.cancelWithSpouse(params);
      return { ok: true, spouseCancelled };
    }

    await this.assignments.cancel(params);
    return { ok: true, spouseCancelled: null };
  }

  /** Registra a quien se ofreció en el grupo tras la encuesta. */
  @Post('locations/:id/shifts/:shiftId/assignments')
  @UseGuards(AdminAuthGuard)
  @HttpCode(201)
  async assignParticipant(
    @Param('id') id: string,
    @Param('shiftId') shiftId: string,
    @Body() dto: CoverShiftDto,
    @CurrentAdmin() admin: AdminTokenPayload,
  ) {
    // Quien no está en el padrón se resuelve antes: se crea su registro mínimo
    // —o se reutiliza el que ya tenga— y a partir de ahí el alta es la misma
    // para todos, con el mismo cupo y las mismas validaciones.
    const participantId =
      dto.participantId ??
      (dto.external
        ? (
            await this.participants.findOrCreateExternal({
              ...dto.external,
              locationId: id,
              actorId: admin.sub,
              actorName: admin.name,
            })
          ).id
        : null);

    if (!participantId) {
      throw new BadRequestException(
        'Indica a cuál de los participantes, o los datos de quien viene de fuera',
      );
    }

    await this.assignments.assignManually({
      shiftId,
      participantId,
      note: dto.note ?? dto.external?.note ?? null,
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
    return this.directory.availableForShift(id, shiftId);
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

  /**
   * A quién hay que confirmarle en el grupo que cubre un turno.
   *
   * Sin `@SoloAdmin()`: publicar ese mensaje es trabajo de los encargados.
   */
  @Get('locations/:id/confirmations-draft')
  @UseGuards(AdminAuthGuard)
  confirmationsDraft(@Param('id') id: string, @Query() query: ConfirmationsQueryDto) {
    return this.confirmations.build(id, query.days);
  }

  /**
   * El encargado declara que ya publicó el mensaje, para que esas personas no
   * vuelvan a salir en el siguiente. Se guarda **después** de que lo confirme,
   * nunca al copiar: entre una cosa y otra puede no llegar a pegarlo.
   */
  @Post('locations/:id/confirmations/announced')
  @UseGuards(AdminAuthGuard)
  announceConfirmations(
    @Param('id') id: string,
    @Body() dto: AnnounceConfirmationsDto,
    @CurrentAdmin() admin: AdminTokenPayload,
  ) {
    return this.confirmations.announce(id, dto.keys, { id: admin.sub, name: admin.name });
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
    return this.reports.auditHistory({
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
