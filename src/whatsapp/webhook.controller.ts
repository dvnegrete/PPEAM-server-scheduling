import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Logger,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { InboundService } from './inbound.service';
import { WhatsAppSignatureGuard } from './signature.guard';
import { MetaWebhookBody } from './types/webhook.types';
import { WebhookParser } from './webhook.parser';

@Controller('webhooks/whatsapp')
export class WhatsAppWebhookController {
  private readonly logger = new Logger(WhatsAppWebhookController.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly parser: WebhookParser,
    private readonly inbound: InboundService,
  ) {}

  /** Verificación de suscripción que hace Meta al configurar el webhook. */
  @Get()
  verify(
    @Query('hub.mode') mode?: string,
    @Query('hub.verify_token') token?: string,
    @Query('hub.challenge') challenge?: string,
  ): string {
    if (mode !== 'subscribe') {
      throw new BadRequestException('Modo de verificación no soportado');
    }
    if (token !== this.config.whatsapp.webhookVerifyToken) {
      throw new ForbiddenException('Token de verificación incorrecto');
    }
    this.logger.log('Webhook verificado por Meta');
    return challenge ?? '';
  }

  /**
   * Meta espera un 200 en pocos segundos o reintenta el lote completo. Por eso
   * aquí solo se registra lo recibido y se responde; el trabajo real ocurre
   * después, disparado por el evento interno.
   */
  @Post()
  @HttpCode(200)
  @UseGuards(WhatsAppSignatureGuard)
  async receive(@Body() body: MetaWebhookBody): Promise<{ received: true }> {
    const { events, statuses } = this.parser.parse(body);
    if (events.length > 0 || statuses.length > 0) {
      this.logger.debug(`Webhook: ${events.length} mensaje(s), ${statuses.length} acuse(s)`);
      await this.inbound.ingest(events, statuses);
    }
    return { received: true };
  }
}
