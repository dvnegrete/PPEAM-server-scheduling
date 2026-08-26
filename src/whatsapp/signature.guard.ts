import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { AppConfigService } from '../config/app-config.service';

/**
 * Verifica la firma X-Hub-Signature-256 de Meta sobre el cuerpo crudo.
 * Sin esto, cualquiera que conozca la URL podría inyectar cancelaciones falsas.
 */
@Injectable()
export class WhatsAppSignatureGuard implements CanActivate {
  private readonly logger = new Logger(WhatsAppSignatureGuard.name);

  constructor(private readonly config: AppConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RawBodyRequest<Request>>();
    const appSecret = this.config.whatsapp.appSecret;

    if (!appSecret) {
      // En desarrollo con el driver stub todavía no hay credenciales de Meta.
      if (this.config.isProduction) {
        throw new UnauthorizedException('Falta WHATSAPP_APP_SECRET para validar la firma');
      }
      this.logger.warn('Sin WHATSAPP_APP_SECRET: la firma del webhook no se está validando');
      return true;
    }

    const header = request.header('x-hub-signature-256');
    if (!header?.startsWith('sha256=')) {
      throw new UnauthorizedException('Falta la firma del webhook');
    }

    const raw = request.rawBody;
    if (!raw) {
      throw new UnauthorizedException('No se recibió el cuerpo crudo para validar la firma');
    }

    const expected = createHmac('sha256', appSecret).update(raw).digest();
    const received = Buffer.from(header.slice('sha256='.length), 'hex');

    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      throw new UnauthorizedException('Firma del webhook inválida');
    }

    return true;
  }
}
