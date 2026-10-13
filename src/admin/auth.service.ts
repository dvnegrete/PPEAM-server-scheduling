import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ActorType, AdminRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { AUDIT_ACTIONS, AuditService } from '../audit/audit.service';
import { TimeService } from '../common/time/time.service';
import { PrismaService } from '../prisma/prisma.service';
import { PERFIL_INCLUDE, perfilDe } from './perfil-de-cuenta';

/** Coste de bcrypt, compartido por el login y por el alta de cuentas. */
export const BCRYPT_COST = 12;

export interface AdminTokenPayload {
  sub: string;
  email: string;
  name: string;
  role: AdminRole;
  /**
   * Versión de la cuenta cuando se emitió el token.
   *
   * El guard la compara con la de la base: así cambiar la contraseña o
   * desactivar la cuenta invalida los tokens ya emitidos en lugar de dejarlos
   * vivos hasta que caduquen.
   */
  tv: number;
}

@Injectable()
export class AdminAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly time: TimeService,
    private readonly audit: AuditService,
  ) {}

  async login(email: string, password: string): Promise<{ token: string; name: string }> {
    const normalizado = email.toLowerCase().trim();
    const user = await this.prisma.adminUser.findUnique({
      where: { email: normalizado },
      include: PERFIL_INCLUDE,
    });

    // Se compara siempre contra un hash para que el tiempo de respuesta no
    // revele si el correo existe. Una cuenta sin contraseña —las de Google, el
    // día que existan— cae aquí y no puede entrar por esta vía.
    const hash =
      user?.passwordHash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidi';
    const valid = await bcrypt.compare(password, hash);

    if (!user || !user.active || !user.passwordHash || !valid) {
      // Se registra el intento, pero nunca la contraseña. El límite de peticiones
      // del endpoint es lo que evita que esto sea escritura sin tope.
      await this.audit.recordSystem(AUDIT_ACTIONS.ADMIN_LOGIN_FAILED, 'AdminUser', null, {
        email: normalizado,
        motivo: !user ? 'correo desconocido' : !user.active ? 'cuenta inactiva' : 'contraseña',
      });
      throw new UnauthorizedException('Correo o contraseña incorrectos');
    }

    await this.prisma.adminUser.update({
      where: { id: user.id },
      data: { lastLoginAt: this.time.now() },
    });

    // El nombre viaja en el token porque se usa para sellar quién capturó cada
    // cancelación y cada cobertura, y se muestra tal cual en el tablero. Sale
    // del perfil efectivo: si la cuenta está vinculada, es el del padrón.
    const nombre = perfilDe(user).fullName;

    await this.audit.record({
      actorType: ActorType.ADMIN,
      actorId: user.id,
      actorName: nombre,
      action: AUDIT_ACTIONS.ADMIN_LOGIN,
      entity: 'AdminUser',
      entityId: user.id,
      metadata: { email: user.email, role: user.role },
    });

    const payload: AdminTokenPayload = {
      sub: user.id,
      email: user.email,
      name: nombre,
      role: user.role,
      tv: user.tokenVersion,
    };
    return { token: await this.jwt.signAsync(payload), name: nombre };
  }

  async verify(token: string): Promise<AdminTokenPayload> {
    try {
      return await this.jwt.verifyAsync<AdminTokenPayload>(token);
    } catch {
      throw new UnauthorizedException('Sesión inválida o expirada');
    }
  }
}
