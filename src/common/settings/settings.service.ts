import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Location } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  DEFAULT_LOCATION_SETTINGS,
  LocationSettings,
  locationSettingsSchema,
} from './location-settings';

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Parámetros efectivos de un punto: los guardados sobre los valores por defecto.
   * Un JSON malformado no tumba la operación; se registra y se usan los defaults.
   */
  resolve(location: Pick<Location, 'id' | 'settings'>): LocationSettings {
    const stored = (location.settings ?? {}) as Record<string, unknown>;
    const parsed = locationSettingsSchema.safeParse(stored);
    if (!parsed.success) {
      this.logger.warn(
        `Configuración inválida en el punto ${location.id}, se usan los valores por defecto: ${parsed.error.message}`,
      );
      return DEFAULT_LOCATION_SETTINGS;
    }
    return parsed.data;
  }

  async forLocation(locationId: string): Promise<LocationSettings> {
    const location = await this.prisma.location.findUnique({
      where: { id: locationId },
      select: { id: true, settings: true },
    });
    if (!location) {
      throw new NotFoundException(`No existe el punto de exhibición ${locationId}`);
    }
    return this.resolve(location);
  }

  /** Actualiza solo las claves recibidas, conservando el resto. */
  async update(locationId: string, patch: Partial<LocationSettings>): Promise<LocationSettings> {
    const current = await this.forLocation(locationId);
    const merged = locationSettingsSchema.parse({ ...current, ...patch });
    await this.prisma.location.update({
      where: { id: locationId },
      data: { settings: merged },
    });
    return merged;
  }
}
