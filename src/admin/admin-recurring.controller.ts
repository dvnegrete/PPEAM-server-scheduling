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
  ) {}

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
}
