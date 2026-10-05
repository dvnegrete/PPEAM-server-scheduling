import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedRequest } from './admin-auth.guard';
import type { AdminTokenPayload } from './auth.service';

/**
 * Administrador autenticado que hizo la petición.
 *
 * Se usa para sellar quién capturó cada movimiento: el tablero muestra ese nombre
 * junto a la cancelación o la cobertura, sin tener que consultar la bitácora.
 */
export const CurrentAdmin = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AdminTokenPayload => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.admin) {
      // El guard siempre corre antes; si no está, es un error de programación.
      throw new Error('CurrentAdmin se usó en una ruta sin AdminAuthGuard');
    }
    return request.admin;
  },
);
