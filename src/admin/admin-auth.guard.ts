import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminRole } from '@prisma/client';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { AdminAuthService, AdminTokenPayload } from './auth.service';

export interface AuthenticatedRequest extends Request {
  admin?: AdminTokenPayload;
}

const SOLO_ADMIN = 'soloAdmin';
/** El endpoint exige rol de administrador: un encargado recibe 403. */
export const SoloAdmin = () => SetMetadata(SOLO_ADMIN, true);

const SIN_CAMBIO_PENDIENTE = 'sinCambioPendiente';
/**
 * El endpoint se puede usar aunque la cuenta deba cambiar su contraseña.
 *
 * Solo lo llevan «quién soy» y «cambiar mi contraseña»: son los dos que hacen
 * falta para poder salir de ese estado.
 */
export const PermitidoConCambioPendiente = () => SetMetadata(SIN_CAMBIO_PENDIENTE, true);

/**
 * Autenticación y autorización del panel.
 *
 * Las tres comprobaciones que van más allá de validar la firma están aquí a
 * propósito, en un solo sitio: repartidas por los controladores sería cuestión
 * de tiempo que un endpoint nuevo se olvidara de alguna.
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    private readonly auth: AdminAuthService,
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.header('authorization');

    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Falta el token de acceso');
    }

    const payload = await this.auth.verify(header.slice('Bearer '.length));

    // La cuenta se relee en cada petición. Es una lectura por clave primaria
    // —inapreciable a esta escala— y es lo que hace que desactivar a alguien o
    // cambiarle la contraseña corte su sesión al instante en lugar de dejarla
    // viva hasta que el token caduque, hasta doce horas después.
    const cuenta = await this.prisma.adminUser.findUnique({
      where: { id: payload.sub },
      select: { active: true, role: true, tokenVersion: true, mustChangePassword: true },
    });

    if (!cuenta || !cuenta.active || cuenta.tokenVersion !== payload.tv) {
      throw new UnauthorizedException('Sesión inválida o expirada');
    }

    // El rol se toma de la base, no del token: un cambio de rol surte efecto sin
    // esperar a que la persona vuelva a entrar.
    request.admin = { ...payload, role: cuenta.role };

    if (
      this.reflector.getAllAndOverride<boolean>(SOLO_ADMIN, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      if (cuenta.role !== AdminRole.ADMIN) {
        throw new ForbiddenException('Hace falta ser administrador para esto');
      }
    }

    // Obligar a cambiar la contraseña tiene que valer también para la API: si
    // solo lo hiciera el panel, bastaría con llamar a los endpoints a mano.
    if (cuenta.mustChangePassword) {
      const permitido = this.reflector.getAllAndOverride<boolean>(SIN_CAMBIO_PENDIENTE, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (!permitido) {
        throw new ForbiddenException('Tienes que cambiar tu contraseña antes de continuar');
      }
    }

    return true;
  }
}
