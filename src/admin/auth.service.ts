import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { fullName } from '../common/names/person-name';
import { TimeService } from '../common/time/time.service';
import { PrismaService } from '../prisma/prisma.service';

export interface AdminTokenPayload {
  sub: string;
  email: string;
  name: string;
}

@Injectable()
export class AdminAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly time: TimeService,
  ) {}

  async login(email: string, password: string): Promise<{ token: string; name: string }> {
    const user = await this.prisma.adminUser.findUnique({ where: { email: email.toLowerCase() } });

    // Se compara siempre contra un hash para que el tiempo de respuesta no
    // revele si el correo existe.
    const hash =
      user?.passwordHash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidi';
    const valid = await bcrypt.compare(password, hash);

    if (!user || !user.active || !valid) {
      throw new UnauthorizedException('Correo o contraseña incorrectos');
    }

    await this.prisma.adminUser.update({
      where: { id: user.id },
      data: { lastLoginAt: this.time.now() },
    });

    // El nombre viaja en el token porque se usa para sellar quién capturó cada
    // cancelación y cada cobertura, y se muestra tal cual en el tablero.
    const nombre = fullName(user);
    const payload: AdminTokenPayload = { sub: user.id, email: user.email, name: nombre };
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
