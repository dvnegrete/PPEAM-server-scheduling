import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
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

  /**
   * Nombre y dirección del punto, que es lo que identifica al exhibidor ante
   * quien lo lee: la cabecera del panel y el mensaje que se publica en el grupo
   * de suplencias salen de aquí.
   */
  async updateIdentity(
    locationId: string,
    datos: { name?: string; address?: string | null },
  ): Promise<Location> {
    const data: { name?: string; address?: string | null } = {};

    if (datos.name !== undefined) {
      const name = datos.name.trim();
      if (name.length === 0) {
        throw new BadRequestException('El nombre del punto no puede quedar vacío');
      }
      data.name = name;
    }

    // Una dirección en blanco se guarda como ausente, no como cadena vacía: lo
    // que la lee decide entre nombrarla o no, y «, » suelto no es una dirección.
    if (datos.address !== undefined) {
      const address = datos.address?.trim();
      data.address = address ? address : null;
    }

    if (Object.keys(data).length === 0) {
      return this.prisma.location.findUniqueOrThrow({ where: { id: locationId } });
    }

    const location = await this.prisma.location.findUnique({
      where: { id: locationId },
      select: { id: true },
    });
    if (!location) {
      throw new NotFoundException(`No existe el punto de exhibición ${locationId}`);
    }

    return this.prisma.location.update({ where: { id: locationId }, data });
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
