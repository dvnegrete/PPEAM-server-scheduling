import { Global, Module } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { CloudApiClient } from './clients/cloud-api.client';
import { StubWhatsAppClient } from './clients/stub.client';
import { WHATSAPP_CLIENT } from './clients/whatsapp-client.interface';
import { InboundService } from './inbound.service';
import { OutboxService } from './outbox.service';
import { OutboxWorker } from './outbox.worker';
import { WhatsAppSignatureGuard } from './signature.guard';
import { WhatsAppWebhookController } from './webhook.controller';
import { WebhookParser } from './webhook.parser';

@Global()
@Module({
  controllers: [WhatsAppWebhookController],
  providers: [
    StubWhatsAppClient,
    CloudApiClient,
    {
      // El driver se elige por configuración: 'stub' permite recorrer todos los
      // flujos sin credenciales de Meta ni costo por mensaje.
      provide: WHATSAPP_CLIENT,
      inject: [AppConfigService, StubWhatsAppClient, CloudApiClient],
      useFactory: (
        config: AppConfigService,
        stub: StubWhatsAppClient,
        cloud: CloudApiClient,
      ) => (config.whatsapp.driver === 'cloud-api' ? cloud : stub),
    },
    WebhookParser,
    InboundService,
    OutboxService,
    OutboxWorker,
    WhatsAppSignatureGuard,
  ],
  exports: [WHATSAPP_CLIENT, OutboxService, InboundService, StubWhatsAppClient, OutboxWorker],
})
export class WhatsAppModule {}
