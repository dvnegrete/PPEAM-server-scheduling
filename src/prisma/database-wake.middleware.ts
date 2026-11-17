import { Injectable, NestMiddleware } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Pasado este rato sin peticiones se da por hecho que la base pudo dormirse.
 * Es menor que el plazo con que la plataforma la duerme, para no llegar tarde.
 */
const IDLE_BEFORE_CHECK_MS = 5 * 60_000;

/**
 * Antes de atender una petición tras un rato de inactividad, espera a que la
 * base esté despierta.
 *
 * Sin esto, la primera consulta después de dormir falla y la persona ve un
 * error por algo que se resuelve solo en segundos. Se hace aquí, antes de
 * cualquier lectura o escritura, para que ninguna operación tenga que
 * repetirse a medias: cuando la petición empieza, la base ya contesta.
 */
@Injectable()
export class DatabaseWakeMiddleware implements NestMiddleware {
  private lastRequestAt = 0;
  private waking: Promise<void> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async use(_request: unknown, _response: unknown, next: (error?: unknown) => void): Promise<void> {
    try {
      if (Date.now() - this.lastRequestAt > IDLE_BEFORE_CHECK_MS) {
        // Las peticiones que llegan juntas comparten la misma espera.
        this.waking ??= this.prisma.ensureReachable().finally(() => {
          this.waking = null;
        });
        await this.waking;
      }
      this.lastRequestAt = Date.now();
      next();
    } catch (error) {
      next(error);
    }
  }

  /** Tras un fallo de conexión, la siguiente petición vuelve a comprobar. */
  markUnreachable(): void {
    this.lastRequestAt = 0;
  }
}
