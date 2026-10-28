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
import { displayName, formalName, PADRON_ORDER } from '../common/names/person-name';
import { SettingsService } from '../common/settings/settings.service';
import { CsvImportService } from '../import/csv-import.service';
import { ParticipantProfileService } from '../participants/participant-profile.service';
import { ParticipantsService } from '../participants/participants.service';
import { PhoneService } from '../common/phone/phone.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReportsService } from '../reports/reports.service';
import { ScheduleGeneratorService } from '../scheduling/schedule-generator.service';
import { AdminAuthGuard, PermitidoConCambioPendiente, SoloAdmin } from './admin-auth.guard';
import { AdminUsersService } from './admin-users.service';
import {
  AnnounceConfirmationsDto,
  AssignParticipantDto,
  CancelAssignmentDto,
  ConfirmationsQueryDto,
  ChangeOwnPasswordDto,
  CoverShiftDto,
  CreateAdminUserDto,
  ResetPasswordDto,
  UpdateAdminUserDto,
  CreateParticipantDto,
  CreateWindowDto,
  UpdateMaritalDto,
  UpdateOrganizationDto,
  UpdateParticipantDto,
  ImportDto,
  LoginDto,
  MonthQueryDto,
  AuditQueryDto,
  PollDraftQueryDto,
  RangeQueryDto,
  UpdateLocationDto,
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
import { ConfirmationsDraftService } from '../reports/confirmations-draft.service';
import { PollDraftService } from '../reports/poll-draft.service';
import { RecurringAssignmentsService } from '../scheduling/recurring-assignments.service';
import { ThrottlerGuard } from '@nestjs/throttler';
import {
  ActorType,
  AdminRole,
  MaritalStatus,
  ParticipantRole,
  ParticipantStatus,
} from '@prisma/client';
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
    private readonly confirmations: ConfirmationsDraftService,
    private readonly organization: OrganizationFieldsService,
    private readonly recurring: RecurringAssignmentsService,
    private readonly profiles: ParticipantProfileService,
    private readonly phone: PhoneService,
    private readonly adminUsers: AdminUsersService,
  ) {}

  @Post('login')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  // -------------------------------------------------------------------------
  // Cuentas del panel
  // -------------------------------------------------------------------------

  /**
   * Quién soy.
   *
   * El panel lo necesita para decidir qué pestañas pinta y si tiene que
   * obligar a cambiar la contraseña antes de dejar ver nada.
   */
  @Get('me')
  @UseGuards(AdminAuthGuard)
  @PermitidoConCambioPendiente()
  me(@CurrentAdmin() admin: AdminTokenPayload) {
    return this.adminUsers.byId(admin.sub);
  }

  /** Cambiar mi propia contraseña. Cierra las demás sesiones abiertas. */
  @Post('me/password')
  @UseGuards(AdminAuthGuard)
  @PermitidoConCambioPendiente()
  @HttpCode(200)
  async changeOwnPassword(
    @Body() dto: ChangeOwnPasswordDto,
    @CurrentAdmin() admin: AdminTokenPayload,
  ) {
    await this.adminUsers.changeOwnPassword(admin.sub, dto.current, dto.password);
    // El token lleva la versión anterior, así que deja de valer: hay que volver
    // a entrar, y eso es justamente lo que se quiere al cambiar la contraseña.
    return { ok: true, vuelveAEntrar: true };
  }

  @Get('admin-users')
  @UseGuards(AdminAuthGuard)
  @SoloAdmin()
  adminUsersList() {
    return this.adminUsers.list();
  }

  @Post('admin-users')
  @UseGuards(AdminAuthGuard)
  @SoloAdmin()
  @HttpCode(201)
  createAdminUser(@Body() dto: CreateAdminUserDto, @CurrentAdmin() admin: AdminTokenPayload) {
    return this.adminUsers.create(
      { ...dto, role: AdminRole[dto.role] },
      { id: admin.sub, name: admin.name },
    );
  }

  @Patch('admin-users/:adminUserId')
  @UseGuards(AdminAuthGuard)
  @SoloAdmin()
  updateAdminUser(
    @Param('adminUserId') adminUserId: string,
    @Body() dto: UpdateAdminUserDto,
    @CurrentAdmin() admin: AdminTokenPayload,
  ) {
    return this.adminUsers.update(
      adminUserId,
      { ...dto, role: dto.role ? AdminRole[dto.role] : undefined },
      { id: admin.sub, name: admin.name },
    );
  }

  /** Restablecer la contraseña de otra cuenta. */
  @Post('admin-users/:adminUserId/password')
  @UseGuards(AdminAuthGuard)
  @SoloAdmin()
  @HttpCode(200)
  async resetAdminUserPassword(
    @Param('adminUserId') adminUserId: string,
    @Body() dto: ResetPasswordDto,
    @CurrentAdmin() admin: AdminTokenPayload,
  ) {
    await this.adminUsers.resetPassword(adminUserId, dto.password, {
      id: admin.sub,
      name: admin.name,
    });
    return { ok: true };
  }

  // -------------------------------------------------------------------------

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
    const padron = await this.prisma.participant.findMany({
      where: { memberships: { some: { locationId: id, active: true } } },
      orderBy: [...PADRON_ORDER],
      select: padronSelect(id),
    });

    return padron.map(flattenMembership);
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
    const { cancelledShifts, warnings } = await this.profiles.updateProfile({
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

    const fila = await this.prisma.participant.findUniqueOrThrow({
      where: { id: participantId },
      select: padronSelect(id),
    });

    return { ...flattenMembership(fila), cancelledShifts, warnings };
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
  // Turnos fijos (quién atiende habitualmente cada franja)
  // -------------------------------------------------------------------------

  /** Las plantillas del punto con sus titulares habituales. */
  @Get('locations/:id/recurring')
  @UseGuards(AdminAuthGuard)
  async recurringSlots(@Param('id') id: string) {
    const [slots, porPersona, padron] = await Promise.all([
      this.recurring.listByLocation(id),
      this.recurring.countByParticipant(id),
      this.prisma.participant.findMany({
        where: { memberships: { some: { locationId: id, active: true } } },
        select: {
          id: true,
          firstName: true,
          paternalSurname: true,
          maternalSurname: true,
          displayName: true,
        },
        orderBy: [...PADRON_ORDER],
      }),
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
        'Indica a quién del padrón, o los datos de quien viene de fuera',
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
  async availableParticipants(@Param('id') id: string, @Param('shiftId') shiftId: string) {
    const candidatos = await this.prisma.participant.findMany({
      where: {
        status: 'ACTIVE',
        OR: [
          { memberships: { some: { locationId: id, active: true } } },
          // Los de fuera que ya han cubierto **en este punto**. El acotado
          // importa: sin él, cada invitado creado aparecería en todos los puntos
          // para siempre, y la lista dejaría de ser de quien de verdad ha
          // ayudado aquí.
          { external: true, assignments: { some: { shift: { locationId: id } } } },
        ],
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
        phoneE164: true,
        external: true,
      },
      orderBy: [...PADRON_ORDER],
    });

    // El teléfono va ya formateado. Quien se ofrece para cubrir lo hace desde su
    // número, así que es el dato que el administrador tiene a mano para
    // buscarlo; en E.164 crudo no se puede leer ni comparar de un vistazo. Se
    // formatea aquí y no en el panel para no meter la librería de teléfonos en
    // el paquete del navegador, y los dígitos sirven igual para buscar.
    return candidatos.map(({ phoneE164, ...persona }) => ({
      ...persona,
      phone: this.phone.format(phoneE164),
    }));
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

/**
 * Columnas del padrón. Se comparten entre la consulta y la edición para que el
 * panel reciba exactamente la misma forma por los dos caminos.
 */
function padronSelect(locationId: string) {
  return {
    id: true,
    firstName: true,
    paternalSurname: true,
    maternalSurname: true,
    displayName: true,
    phoneE164: true,
    status: true,
    optInAt: true,
    // El rol y la preferencia de avisos son del vínculo con este punto.
    memberships: {
      where: { locationId },
      select: { role: true, coverageAlerts: true, isPrimary: true },
    },
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
  } as const;
}

type FilaPadron = {
  memberships: Array<{ role: ParticipantRole; coverageAlerts: boolean; isPrimary: boolean }>;
};

/** Aplana la membresía, para que el panel no tenga que saber que existe. */
function flattenMembership<T extends FilaPadron>({ memberships, ...persona }: T) {
  return {
    ...persona,
    role: memberships[0]?.role ?? 'PARTICIPANT',
    coverageAlerts: memberships[0]?.coverageAlerts ?? true,
    isPrimaryLocation: memberships[0]?.isPrimary ?? false,
  };
}
