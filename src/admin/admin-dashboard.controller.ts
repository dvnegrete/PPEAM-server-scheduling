import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ActorType } from '@prisma/client';
import { ParticipantDirectoryService } from '../participants/participant-directory.service';
import { ParticipantsService } from '../participants/participants.service';
import { AuditTrailService } from '../reports/audit-trail.service';
import { ConfirmationsDraftService } from '../reports/confirmations-draft.service';
import { DashboardService } from '../reports/dashboard.service';
import { PollDraftService } from '../reports/poll-draft.service';
import { AssignmentsService } from '../scheduling/assignments.service';
import { AdminAuthGuard } from './admin-auth.guard';
import {
  AnnounceConfirmationsDto,
  CancelAssignmentDto,
  ConfirmationsQueryDto,
  CoverShiftDto,
  PollDraftQueryDto,
  RangeQueryDto,
} from './admin.dto';
import { AdminTokenPayload } from './auth.service';
import { CurrentAdmin } from './current-admin.decorator';

/** Tablero operativo: los turnos del día a día, la encuesta y las confirmaciones. */
@Controller('api/admin')
export class AdminDashboardController {
  constructor(
    private readonly dashboardReport: DashboardService,
    private readonly auditTrail: AuditTrailService,
    private readonly assignments: AssignmentsService,
    private readonly participants: ParticipantsService,
    private readonly directory: ParticipantDirectoryService,
    private readonly pollDraft_: PollDraftService,
    private readonly confirmations: ConfirmationsDraftService,
  ) {}

  @Get('locations/:id/dashboard')
  @UseGuards(AdminAuthGuard)
  dashboard(@Param('id') id: string, @Query() query: RangeQueryDto) {
    return this.dashboardReport.dashboard(id, new Date(query.from), new Date(query.to));
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
    return this.auditTrail.shiftHistory(shiftId);
  }

  /** Actividad reciente del punto, para la cabecera del tablero. */
  @Get('locations/:id/movements')
  @UseGuards(AdminAuthGuard)
  movements(@Param('id') id: string, @Query('limit') limit?: string) {
    return this.auditTrail.recentMovements(id, limit ? Number(limit) : 20);
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
}
