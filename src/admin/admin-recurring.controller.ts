import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { displayName, formalName } from '../common/names/person-name';
import { ParticipantDirectoryService } from '../participants/participant-directory.service';
import { RecurringAssignmentsService } from '../scheduling/recurring-assignments.service';
import { RecurringSyncService } from '../scheduling/recurring-sync.service';
import { AdminAuthGuard } from './admin-auth.guard';
import { AssignParticipantDto, SetCaptainDto } from './admin.dto';
import { AdminTokenPayload } from './auth.service';
import { CurrentAdmin } from './current-admin.decorator';

/** Turnos fijos: quién atiende habitualmente cada franja. */
@Controller('api/admin')
export class AdminRecurringController {
  constructor(
    private readonly recurring: RecurringAssignmentsService,
    private readonly directory: ParticipantDirectoryService,
    private readonly sync: RecurringSyncService,
  ) {}

  /** Las plantillas del punto con sus titulares habituales. */
  @Get('locations/:id/recurring')
  @UseGuards(AdminAuthGuard)
  async recurringSlots(@Param('id') id: string) {
    const [slots, porPersona, padron, pendingMonths] = await Promise.all([
      this.recurring.listByLocation(id),
      this.recurring.countByParticipant(id),
      this.directory.namesByLocation(id),
      this.sync.pendingChanges(id),
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
      // Meses próximos ya generados que aún no reflejan los turnos fijos: el
      // rol del mes de esos meses saldría con la gente anterior.
      pendingMonths,
    };
  }

  /** Aplica los turnos fijos a los meses próximos que ya están generados. */
  @Post('locations/:id/recurring/apply')
  @UseGuards(AdminAuthGuard)
  @HttpCode(200)
  applyToUpcomingMonths(@Param('id') id: string, @CurrentAdmin() admin: AdminTokenPayload) {
    return this.sync.applyToUpcomingMonths(id, { id: admin.sub, name: admin.name });
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
}
