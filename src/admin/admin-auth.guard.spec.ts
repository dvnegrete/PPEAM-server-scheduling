import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminRole } from '@prisma/client';
import { AdminAuthGuard } from './admin-auth.guard';
import { AdminAuthService, AdminTokenPayload } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';

/** Estado de la cuenta tal como lo lee el guard. */
interface EnLaBase {
  active: boolean;
  role: AdminRole;
  tokenVersion: number;
  mustChangePassword: boolean;
}

const PAYLOAD: AdminTokenPayload = {
  sub: 'cuenta-1',
  email: 'elena@correo.com',
  name: 'Elena Mora',
  role: AdminRole.ADMIN,
  tv: 3,
};

function armar(opciones: {
  header?: string;
  payload?: AdminTokenPayload | null;
  enLaBase?: EnLaBase | null;
  soloAdmin?: boolean;
  permitidoConCambio?: boolean;
}) {
  const request: { admin?: AdminTokenPayload; header: (n: string) => string | undefined } = {
    header: () => opciones.header,
  };

  const auth = {
    verify: jest.fn(() =>
      opciones.payload
        ? Promise.resolve(opciones.payload)
        : Promise.reject(new UnauthorizedException('Sesión inválida o expirada')),
    ),
  } as unknown as AdminAuthService;

  const prisma = {
    adminUser: { findUnique: jest.fn(() => Promise.resolve(opciones.enLaBase ?? null)) },
  } as unknown as PrismaService;

  const reflector = {
    getAllAndOverride: jest.fn((clave: string) =>
      clave === 'soloAdmin' ? opciones.soloAdmin : opciones.permitidoConCambio,
    ),
  } as unknown as Reflector;

  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;

  return { guard: new AdminAuthGuard(auth, prisma, reflector), context, request };
}

const CUENTA_OK: EnLaBase = {
  active: true,
  role: AdminRole.ADMIN,
  tokenVersion: 3,
  mustChangePassword: false,
};

describe('AdminAuthGuard', () => {
  describe('el token', () => {
    it('rechaza una petición sin cabecera', async () => {
      const { guard, context } = armar({ header: undefined });
      await expect(guard.canActivate(context)).rejects.toThrow(/Falta el token/);
    });

    it('rechaza un esquema distinto de Bearer', async () => {
      const { guard, context } = armar({ header: 'Basic dXN1YXJpbzpjbGF2ZQ==' });
      await expect(guard.canActivate(context)).rejects.toThrow(/Falta el token/);
    });

    it('rechaza un token que no verifica', async () => {
      const { guard, context } = armar({ header: 'Bearer malo', payload: null });
      await expect(guard.canActivate(context)).rejects.toThrow(/inválida o expirada/);
    });

    it('deja pasar un token válido y publica la identidad', async () => {
      const { guard, context, request } = armar({
        header: 'Bearer bueno',
        payload: PAYLOAD,
        enLaBase: CUENTA_OK,
      });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(request.admin?.sub).toBe('cuenta-1');
    });
  });

  describe('revocación', () => {
    it('rechaza si la versión del token ya no coincide', async () => {
      // Es el caso de haber cambiado la contraseña o desactivado la cuenta: el
      // token sigue siendo criptográficamente válido, pero ya no sirve.
      const { guard, context } = armar({
        header: 'Bearer bueno',
        payload: PAYLOAD,
        enLaBase: { ...CUENTA_OK, tokenVersion: 4 },
      });

      await expect(guard.canActivate(context)).rejects.toThrow(/inválida o expirada/);
    });

    it('rechaza si la cuenta quedó desactivada', async () => {
      const { guard, context } = armar({
        header: 'Bearer bueno',
        payload: PAYLOAD,
        enLaBase: { ...CUENTA_OK, active: false },
      });

      await expect(guard.canActivate(context)).rejects.toThrow(/inválida o expirada/);
    });

    it('rechaza si la cuenta ya no existe', async () => {
      const { guard, context } = armar({
        header: 'Bearer bueno',
        payload: PAYLOAD,
        enLaBase: null,
      });

      await expect(guard.canActivate(context)).rejects.toThrow(/inválida o expirada/);
    });
  });

  describe('autorización por rol', () => {
    it('un encargado no entra donde se exige administrador', async () => {
      const { guard, context } = armar({
        header: 'Bearer bueno',
        payload: { ...PAYLOAD, role: AdminRole.SUPERVISOR },
        enLaBase: { ...CUENTA_OK, role: AdminRole.SUPERVISOR },
        soloAdmin: true,
      });

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });

    it('un administrador sí', async () => {
      const { guard, context } = armar({
        header: 'Bearer bueno',
        payload: PAYLOAD,
        enLaBase: CUENTA_OK,
        soloAdmin: true,
      });

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('el rol se toma de la base, no del token', async () => {
      // Cambiar el rol de alguien surte efecto sin esperar a que vuelva a
      // entrar: el token sigue diciendo lo de antes, y lo que vale es la base.
      const degradada = armar({
        header: 'Bearer bueno',
        payload: PAYLOAD, // el token dice ADMIN
        enLaBase: { ...CUENTA_OK, role: AdminRole.SUPERVISOR },
        soloAdmin: true,
      });
      await expect(degradada.guard.canActivate(degradada.context)).rejects.toThrow(
        ForbiddenException,
      );

      const ascendida = armar({
        header: 'Bearer bueno',
        payload: { ...PAYLOAD, role: AdminRole.SUPERVISOR }, // el token dice ENCARGADO
        enLaBase: CUENTA_OK, // la base dice ADMIN
        soloAdmin: true,
      });
      await expect(ascendida.guard.canActivate(ascendida.context)).resolves.toBe(true);
      expect(ascendida.request.admin?.role).toBe(AdminRole.ADMIN);
    });
  });

  describe('cambio de contraseña pendiente', () => {
    it('encierra a la cuenta en los dos endpoints permitidos', async () => {
      const { guard, context } = armar({
        header: 'Bearer bueno',
        payload: PAYLOAD,
        enLaBase: { ...CUENTA_OK, mustChangePassword: true },
      });

      await expect(guard.canActivate(context)).rejects.toThrow(/cambiar tu contraseña/);
    });

    it('deja pasar los endpoints marcados como permitidos', async () => {
      const { guard, context } = armar({
        header: 'Bearer bueno',
        payload: PAYLOAD,
        enLaBase: { ...CUENTA_OK, mustChangePassword: true },
        permitidoConCambio: true,
      });

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });
  });
});
