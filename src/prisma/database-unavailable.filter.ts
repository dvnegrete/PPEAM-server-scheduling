import { ArgumentsHost, Catch, HttpStatus, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { isDatabaseConnectionError } from './database-connection';
import { DatabaseWakeMiddleware } from './database-wake.middleware';

/**
 * Un fallo de conexión con la base se responde como «servicio no disponible»
 * y no como error interno: es pasajero, y el panel sabe que ante un 503 debe
 * esperar y volver a pedir en lugar de mostrar un error.
 *
 * Todo lo demás sigue el camino de siempre.
 */
@Catch()
export class DatabaseUnavailableFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(DatabaseUnavailableFilter.name);

  constructor(private readonly wake: DatabaseWakeMiddleware) {
    super();
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http' || !isDatabaseConnectionError(exception)) {
      super.catch(exception, host);
      return;
    }

    this.wake.markUnreachable();
    this.logger.warn('Sin conexión con la base de datos; se responde 503 para que se reintente');

    const response = host.switchToHttp().getResponse<{
      status: (code: number) => { json: (body: unknown) => void };
    }>();
    response.status(HttpStatus.SERVICE_UNAVAILABLE).json({
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      message: 'El servidor está arrancando. Vuelve a intentarlo en unos segundos.',
    });
  }
}
