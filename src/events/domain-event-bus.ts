import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

/**
 * Publicación de eventos de dominio con espera.
 *
 * `emit()` de EventEmitter2 no espera a los manejadores asíncronos, así que la
 * tarea del encargado podía quedar sin crearse mientras al participante ya se le
 * había confirmado su cancelación. Aquí se espera a que todos terminen.
 *
 * Un fallo en un manejador se registra pero no se propaga: el cambio de negocio
 * ya está guardado y no debe deshacerse porque una notificación falló.
 */
@Injectable()
export class DomainEventBus {
  private readonly logger = new Logger(DomainEventBus.name);

  constructor(private readonly emitter: EventEmitter2) {}

  async publish<T>(event: string, payload: T): Promise<void> {
    try {
      await this.emitter.emitAsync(event, payload);
    } catch (error) {
      this.logger.error(
        `Un manejador del evento ${event} falló; el cambio de negocio se conserva: ${String(error)}`,
      );
    }
  }
}
