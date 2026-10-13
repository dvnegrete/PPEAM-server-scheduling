import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ActorType, AdminRole, ParticipantRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { AUDIT_ACTIONS, AuditService } from '../audit/audit.service';
import { MembershipsService } from '../participants/memberships.service';
import { PrismaService } from '../prisma/prisma.service';
import { BCRYPT_COST } from './auth.service';
import { PERFIL_INCLUDE, PerfilDeCuenta, perfilDe } from './perfil-de-cuenta';

/** Mínimo de la contraseña. Corto de más no protege; largo de más no se usa. */
export const MINIMO_CONTRASENA = 8;

export interface Actor {
  id: string;
  name: string;
}

/** Una cuenta tal como la ve el panel. */
export interface CuentaDelPanel {
  id: string;
  email: string;
  role: AdminRole;
  active: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  participantId: string | null;
  perfil: PerfilDeCuenta;
}

/**
 * Cuentas del panel: altas, edición y contraseñas.
 *
 * Dos invariantes se sostienen aquí y no en el controlador, porque son las que
 * no pueden depender de que la pantalla las respete:
 *
 * - **Siempre queda al menos un administrador activo.** Es la única forma de
 *   cerrarse la puerta desde dentro y dejar el sistema sin quien lo gobierne.
 * - **La contraseña nunca se devuelve ni se registra**, ni siquiera hasheada.
 */
@Injectable()
export class AdminUsersService {
  private readonly logger = new Logger(AdminUsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly memberships: MembershipsService,
  ) {}

  async list(): Promise<CuentaDelPanel[]> {
    const cuentas = await this.prisma.adminUser.findMany({
      include: PERFIL_INCLUDE,
      orderBy: [{ role: 'asc' }, { paternalSurname: 'asc' }, { firstName: 'asc' }],
    });
    return cuentas.map((cuenta) => this.vista(cuenta));
  }

  async byId(id: string): Promise<CuentaDelPanel> {
    const cuenta = await this.prisma.adminUser.findUnique({
      where: { id },
      include: PERFIL_INCLUDE,
    });
    if (!cuenta) throw new NotFoundException('Esa cuenta ya no existe');
    return this.vista(cuenta);
  }

  async create(
    params: {
      email: string;
      password: string;
      role: AdminRole;
      participantId?: string | null;
      firstName?: string;
      paternalSurname?: string;
      maternalSurname?: string | null;
      phone?: string | null;
      congregation?: string | null;
      circuit?: string | null;
      city?: string | null;
    },
    actor: Actor,
  ): Promise<CuentaDelPanel> {
    const email = this.normalizarCorreo(params.email);
    this.validarContrasena(params.password);

    if (await this.prisma.adminUser.findUnique({ where: { email } })) {
      throw new ConflictException(`Ya hay una cuenta con el correo ${email}`);
    }

    const vinculado = await this.resolverVinculo(params.participantId ?? null, null);

    // Sin vínculo, el nombre es obligatorio: es lo único con lo que se la va a
    // reconocer en la lista.
    if (!vinculado && !(params.firstName?.trim() && params.paternalSurname?.trim())) {
      throw new BadRequestException(
        'Hacen falta el nombre y el apellido, o vincular la cuenta con alguien del padrón',
      );
    }

    const cuenta = await this.prisma.adminUser.create({
      data: {
        email,
        passwordHash: await bcrypt.hash(params.password, BCRYPT_COST),
        role: params.role,
        participantId: vinculado?.id ?? null,
        // La puso un administrador, así que la persona tiene que cambiarla.
        mustChangePassword: true,
        firstName: params.firstName?.trim() || vinculado?.firstName || '',
        paternalSurname: params.paternalSurname?.trim() || vinculado?.paternalSurname || '',
        maternalSurname: params.maternalSurname?.trim() || null,
        phone: params.phone?.trim() || null,
        congregation: params.congregation?.trim() || null,
        circuit: params.circuit?.trim() || null,
        city: params.city?.trim() || null,
      },
      include: PERFIL_INCLUDE,
    });

    await this.sincronizarRolEnElPadron(cuenta.participantId, params.role, actor);

    await this.audit.record({
      actorType: ActorType.ADMIN,
      actorId: actor.id,
      actorName: actor.name,
      action: AUDIT_ACTIONS.ADMIN_USER_CREATED,
      entity: 'AdminUser',
      entityId: cuenta.id,
      after: { email, role: params.role, participantId: cuenta.participantId },
    });

    this.logger.log(`Cuenta ${email} creada con rol ${params.role}`);
    return this.vista(cuenta);
  }

  async update(
    id: string,
    params: {
      email?: string;
      role?: AdminRole;
      active?: boolean;
      /** `null` desvincula; un id vincula; `undefined` no toca el vínculo. */
      participantId?: string | null;
      firstName?: string;
      paternalSurname?: string;
      maternalSurname?: string | null;
      phone?: string | null;
      congregation?: string | null;
      circuit?: string | null;
      city?: string | null;
    },
    actor: Actor,
  ): Promise<CuentaDelPanel> {
    const antes = await this.prisma.adminUser.findUnique({
      where: { id },
      include: PERFIL_INCLUDE,
    });
    if (!antes) throw new NotFoundException('Esa cuenta ya no existe');

    const email = params.email ? this.normalizarCorreo(params.email) : undefined;
    if (email && email !== antes.email) {
      if (await this.prisma.adminUser.findUnique({ where: { email } })) {
        throw new ConflictException(`Ya hay una cuenta con el correo ${email}`);
      }
    }

    // Quitarle el rol de administrador o desactivar a la última cuenta que
    // gobierna el sistema lo dejaría sin nadie que pueda entrar a gestionarlo.
    const pierdeAdmin =
      (params.role !== undefined && params.role !== AdminRole.ADMIN) || params.active === false;
    if (antes.role === AdminRole.ADMIN && antes.active && pierdeAdmin) {
      await this.exigirOtroAdministrador(id, actor);
    }

    const vinculado =
      params.participantId === undefined
        ? undefined
        : await this.resolverVinculo(params.participantId, id);

    const cuenta = await this.prisma.adminUser.update({
      where: { id },
      data: {
        ...(email ? { email } : {}),
        ...(params.role !== undefined ? { role: params.role } : {}),
        ...(params.active !== undefined ? { active: params.active } : {}),
        ...(params.participantId !== undefined ? { participantId: vinculado?.id ?? null } : {}),
        ...(params.firstName !== undefined ? { firstName: params.firstName.trim() } : {}),
        ...(params.paternalSurname !== undefined
          ? { paternalSurname: params.paternalSurname.trim() }
          : {}),
        ...(params.maternalSurname !== undefined
          ? { maternalSurname: params.maternalSurname?.trim() || null }
          : {}),
        ...(params.phone !== undefined ? { phone: params.phone?.trim() || null } : {}),
        ...(params.congregation !== undefined
          ? { congregation: params.congregation?.trim() || null }
          : {}),
        ...(params.circuit !== undefined ? { circuit: params.circuit?.trim() || null } : {}),
        ...(params.city !== undefined ? { city: params.city?.trim() || null } : {}),
        // Desactivar tiene que cortar la sesión ahora, no cuando caduque el token.
        ...(params.active === false ? { tokenVersion: { increment: 1 } } : {}),
      },
      include: PERFIL_INCLUDE,
    });

    await this.sincronizarRolEnElPadron(cuenta.participantId, cuenta.role, actor);

    await this.audit.record({
      actorType: ActorType.ADMIN,
      actorId: actor.id,
      actorName: actor.name,
      action: AUDIT_ACTIONS.ADMIN_USER_UPDATED,
      entity: 'AdminUser',
      entityId: id,
      before: {
        email: antes.email,
        role: antes.role,
        active: antes.active,
        participantId: antes.participantId,
      },
      after: {
        email: cuenta.email,
        role: cuenta.role,
        active: cuenta.active,
        participantId: cuenta.participantId,
      },
    });

    return this.vista(cuenta);
  }

  /** Un administrador restablece la contraseña de otra cuenta. */
  async resetPassword(id: string, password: string, actor: Actor): Promise<void> {
    this.validarContrasena(password);
    const cuenta = await this.prisma.adminUser.findUnique({ where: { id } });
    if (!cuenta) throw new NotFoundException('Esa cuenta ya no existe');

    await this.prisma.adminUser.update({
      where: { id },
      data: {
        passwordHash: await bcrypt.hash(password, BCRYPT_COST),
        // La puso otra persona: hay que cambiarla al entrar. Y las sesiones
        // abiertas se cierran, que es el sentido de restablecerla.
        mustChangePassword: true,
        tokenVersion: { increment: 1 },
      },
    });

    await this.audit.record({
      actorType: ActorType.ADMIN,
      actorId: actor.id,
      actorName: actor.name,
      action: AUDIT_ACTIONS.ADMIN_PASSWORD_RESET,
      entity: 'AdminUser',
      entityId: id,
      metadata: { email: cuenta.email },
    });
  }

  /** Cada quien cambia la suya, demostrando que sabe la actual. */
  async changeOwnPassword(id: string, actual: string, nueva: string): Promise<void> {
    this.validarContrasena(nueva);
    const cuenta = await this.prisma.adminUser.findUnique({ where: { id } });
    if (!cuenta?.passwordHash) throw new NotFoundException('Esa cuenta ya no existe');

    // Se exige la actual para que un token robado no sirva para quedarse con la
    // cuenta: sin esto, bastaría con un token válido para cambiar la contraseña.
    if (!(await bcrypt.compare(actual, cuenta.passwordHash))) {
      throw new BadRequestException('La contraseña actual no es correcta');
    }
    if (actual === nueva) {
      throw new BadRequestException('La contraseña nueva tiene que ser distinta de la actual');
    }

    await this.prisma.adminUser.update({
      where: { id },
      data: {
        passwordHash: await bcrypt.hash(nueva, BCRYPT_COST),
        mustChangePassword: false,
        // Cierra las demás sesiones: si alguien más tenía el token, deja de valer.
        tokenVersion: { increment: 1 },
      },
    });

    await this.audit.record({
      actorType: ActorType.ADMIN,
      actorId: id,
      actorName: cuenta.email,
      action: AUDIT_ACTIONS.ADMIN_PASSWORD_CHANGED,
      entity: 'AdminUser',
      entityId: id,
    });
  }

  // -------------------------------------------------------------------------

  private vista(
    cuenta: Parameters<typeof perfilDe>[0] & {
      id: string;
      email: string;
      role: AdminRole;
      active: boolean;
      mustChangePassword: boolean;
      lastLoginAt: Date | null;
      participantId: string | null;
    },
  ): CuentaDelPanel {
    return {
      id: cuenta.id,
      email: cuenta.email,
      role: cuenta.role,
      active: cuenta.active,
      mustChangePassword: cuenta.mustChangePassword,
      lastLoginAt: cuenta.lastLoginAt?.toISOString() ?? null,
      participantId: cuenta.participantId,
      perfil: perfilDe(cuenta),
    };
  }

  private normalizarCorreo(email: string): string {
    const limpio = email.trim().toLowerCase();
    if (!limpio) throw new BadRequestException('Falta el correo');
    return limpio;
  }

  private validarContrasena(password: string): void {
    if (password.trim().length < MINIMO_CONTRASENA) {
      throw new BadRequestException(
        `La contraseña debe tener al menos ${MINIMO_CONTRASENA} caracteres`,
      );
    }
  }

  /** Comprueba que el vínculo con el padrón sea posible y 1:1. */
  private async resolverVinculo(participantId: string | null, cuentaId: string | null) {
    if (!participantId) return null;

    const persona = await this.prisma.participant.findUnique({ where: { id: participantId } });
    if (!persona) throw new NotFoundException('Ese participante ya no existe');

    const ocupada = await this.prisma.adminUser.findUnique({ where: { participantId } });
    if (ocupada && ocupada.id !== cuentaId) {
      throw new ConflictException(
        `${persona.firstName} ${persona.paternalSurname} ya tiene cuenta (${ocupada.email})`,
      );
    }
    return persona;
  }

  /**
   * El rol de la cuenta y el del padrón van juntos.
   *
   * Es el «un solo interruptor»: marcar una cuenta como encargado le da también
   * el menú de WhatsApp, sin tener que acordarse de marcarlo aparte en el
   * Padrón. Solo aplica a cuentas vinculadas; sin vínculo no hay membresía que
   * tocar.
   */
  private async sincronizarRolEnElPadron(
    participantId: string | null,
    role: AdminRole,
    actor: Actor,
  ): Promise<void> {
    if (!participantId) return;

    let locationId: string;
    try {
      locationId = await this.memberships.primaryLocationId(participantId);
    } catch {
      // Está en el padrón pero sin membresía activa: no hay punto donde darle el
      // rol, y no es un error del alta de la cuenta.
      this.logger.warn(
        `${participantId} no pertenece a ningún punto; no se sincronizó su rol de encargado`,
      );
      return;
    }

    const deseado = role === AdminRole.ADMIN ? ParticipantRole.ADMIN : ParticipantRole.SUPERVISOR;
    await this.memberships.setRole(participantId, locationId, deseado);

    await this.audit.record({
      actorType: ActorType.ADMIN,
      actorId: actor.id,
      actorName: actor.name,
      action: AUDIT_ACTIONS.PARTICIPANT_UPDATED,
      entity: 'LocationMembership',
      entityId: participantId,
      after: { role: deseado },
      metadata: { locationId, motivo: 'rol de la cuenta del panel' },
    });
  }

  /** Impide quedarse sin ningún administrador activo. */
  private async exigirOtroAdministrador(id: string, actor: Actor): Promise<void> {
    const otros = await this.prisma.adminUser.count({
      where: { role: AdminRole.ADMIN, active: true, id: { not: id } },
    });
    if (otros > 0) return;

    throw new BadRequestException(
      id === actor.id
        ? 'No puedes quitarte el acceso: eres el único administrador activo'
        : 'Es el único administrador activo; nombra a otro antes de quitarle el acceso',
    );
  }
}
