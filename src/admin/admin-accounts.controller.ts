import { Body, Controller, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AdminRole } from '@prisma/client';
import { AdminAuthGuard, PermitidoConCambioPendiente, SoloAdmin } from './admin-auth.guard';
import { AdminUsersService } from './admin-users.service';
import {
  ChangeOwnPasswordDto,
  CreateAdminUserDto,
  LoginDto,
  ResetPasswordDto,
  UpdateAdminUserDto,
} from './admin.dto';
import { AdminAuthService, AdminTokenPayload } from './auth.service';
import { CurrentAdmin } from './current-admin.decorator';

/** Acceso al panel y administración de sus cuentas. */
@Controller('api/admin')
export class AdminAccountsController {
  constructor(
    private readonly auth: AdminAuthService,
    private readonly adminUsers: AdminUsersService,
  ) {}

  @Post('login')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

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
}
