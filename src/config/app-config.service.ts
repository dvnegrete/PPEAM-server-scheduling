import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from './env.schema';

/**
 * Acceso tipado a la configuración. Evita `configService.get<string>('CLAVE')`
 * disperso por el código y centraliza los valores derivados.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  private get<K extends keyof Env>(key: K): Env[K] {
    return this.config.get(key, { infer: true });
  }

  get nodeEnv(): Env['NODE_ENV'] {
    return this.get('NODE_ENV');
  }

  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }

  get isTest(): boolean {
    return this.nodeEnv === 'test';
  }

  get port(): number {
    return this.get('PORT');
  }

  /** Zona horaria por defecto; cada punto de exhibición puede sobrescribirla. */
  get defaultTimezone(): string {
    return this.get('APP_TIMEZONE');
  }

  get whatsapp(): {
    driver: Env['WHATSAPP_DRIVER'];
    apiVersion: string;
    phoneNumberId?: string;
    businessAccountId?: string;
    accessToken?: string;
    appSecret?: string;
    webhookVerifyToken: string;
  } {
    return {
      driver: this.get('WHATSAPP_DRIVER'),
      apiVersion: this.get('WHATSAPP_API_VERSION'),
      phoneNumberId: this.get('WHATSAPP_PHONE_NUMBER_ID'),
      businessAccountId: this.get('WHATSAPP_BUSINESS_ACCOUNT_ID'),
      accessToken: this.get('WHATSAPP_ACCESS_TOKEN'),
      appSecret: this.get('WHATSAPP_APP_SECRET'),
      webhookVerifyToken: this.get('WHATSAPP_WEBHOOK_VERIFY_TOKEN'),
    };
  }

  get anthropic(): { apiKey?: string; model: string } {
    return { apiKey: this.get('ANTHROPIC_API_KEY'), model: this.get('ANTHROPIC_MODEL') };
  }

  get jwt(): { secret: string; expiresIn: string } {
    return { secret: this.get('JWT_SECRET'), expiresIn: this.get('JWT_EXPIRES_IN') };
  }
}
