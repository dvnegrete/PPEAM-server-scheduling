import { Injectable } from '@nestjs/common';
import { CountryCode, parsePhoneNumberFromString } from 'libphonenumber-js';

export class InvalidPhoneNumberError extends Error {
  constructor(readonly raw: string) {
    super(`Número de teléfono inválido: "${raw}"`);
    this.name = 'InvalidPhoneNumberError';
  }
}

/**
 * Normalización de teléfonos a E.164.
 *
 * Caso especial de México: WhatsApp identifica a los usuarios mexicanos con un
 * "1" extra después del código de país (+52 1 55 1234 5678), herencia del
 * antiguo prefijo de móviles. Ese formato ya no es E.164 válido, así que el
 * mismo teléfono llega escrito de dos maneras distintas —una en el padrón y
 * otra en el webhook— y sin este tratamiento el sistema no reconocería a quien
 * escribe. Se guarda siempre la forma canónica (sin el 1) y se buscan ambas.
 */
@Injectable()
export class PhoneService {
  private static readonly MEXICO_LEGACY_PREFIX = '521';

  normalize(raw: string, defaultCountry: CountryCode = 'MX'): string {
    const cleaned = this.stripMexicanMobilePrefix(raw.trim());
    const parsed = parsePhoneNumberFromString(cleaned, defaultCountry);
    if (!parsed?.isValid()) {
      throw new InvalidPhoneNumberError(raw);
    }
    return parsed.number;
  }

  /** Igual que `normalize` pero devuelve null en vez de lanzar. */
  tryNormalize(raw: string, defaultCountry: CountryCode = 'MX'): string | null {
    try {
      return this.normalize(raw, defaultCountry);
    } catch {
      return null;
    }
  }

  /**
   * Formas en las que ese mismo teléfono puede estar escrito en la base o
   * llegar desde Meta. Se usa para buscar al participante por cualquiera.
   */
  lookupVariants(e164: string): string[] {
    const variants = new Set<string>([e164, e164.replace(/^\+/, '')]);
    if (e164.startsWith('+52') && !e164.startsWith('+521')) {
      const legacy = `+521${e164.slice(3)}`;
      variants.add(legacy);
      variants.add(legacy.slice(1));
    }
    return [...variants];
  }

  /** Formato legible para mensajes y panel: +52 55 1234 5678. */
  format(e164: string): string {
    const parsed = parsePhoneNumberFromString(e164);
    return parsed?.formatInternational() ?? e164;
  }

  private stripMexicanMobilePrefix(value: string): string {
    const digits = value.replace(/[^\d+]/g, '');
    const withoutPlus = digits.startsWith('+') ? digits.slice(1) : digits;
    if (withoutPlus.startsWith(PhoneService.MEXICO_LEGACY_PREFIX) && withoutPlus.length === 13) {
      return `+52${withoutPlus.slice(3)}`;
    }
    return digits.startsWith('+') ? digits : `+${withoutPlus}`.replace(/^\+(?=\d{10}$)/, '');
  }
}
