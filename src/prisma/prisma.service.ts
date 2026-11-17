import {
  INestApplication,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { isDatabaseConnectionError } from './database-connection';

/** Cuánto se insiste mientras la base despierta, y cada cuánto. */
const WAKE_TIMEOUT_MS = 30_000;
const WAKE_RETRY_DELAY_MS = 1_000;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    // Al arrancar la base puede estar dormida todavía: se le da tiempo en vez
    // de dejar caer el proceso en el primer intento.
    await this.whileWaking(() => this.$connect());
    this.logger.log('Conectado a PostgreSQL');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Espera a que la base conteste.
   *
   * La base se duerme tras un rato sin uso y el primer intento de conexión la
   * despierta, pero falla. Aquí se insiste con una consulta que no lee ni
   * escribe nada, para que lo que venga después encuentre la base lista.
   */
  async ensureReachable(): Promise<void> {
    await this.whileWaking(() => this.$queryRaw`SELECT 1`);
  }

  /** Repite la operación mientras el fallo sea de conexión, hasta el plazo. */
  private async whileWaking(operation: () => Promise<unknown>): Promise<void> {
    const deadline = Date.now() + WAKE_TIMEOUT_MS;
    let waiting = false;

    for (;;) {
      try {
        await operation();
        if (waiting) this.logger.log('La base de datos ya responde');
        return;
      } catch (error) {
        if (!isDatabaseConnectionError(error) || Date.now() >= deadline) throw error;
        if (!waiting) this.logger.warn('La base de datos no responde; se espera a que despierte');
        waiting = true;
        await new Promise((resolve) => setTimeout(resolve, WAKE_RETRY_DELAY_MS));
      }
    }
  }

  enableShutdownHooks(app: INestApplication): void {
    process.on('beforeExit', () => {
      void app.close();
    });
  }
}
