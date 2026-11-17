import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { SupervisorsService } from '../supervisors/supervisors.service';
import { AdminAuthGuard } from './admin-auth.guard';
import { CreateWindowDto } from './admin.dto';

/** Guardia de encargados: quién atiende y en qué franjas. */
@Controller('api/admin')
export class AdminSupervisorsController {
  constructor(private readonly supervisors: SupervisorsService) {}

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
}
