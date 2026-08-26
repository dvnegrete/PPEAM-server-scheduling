import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';

async function bootstrap(): Promise<void> {
  // `rawBody` es necesario para validar la firma X-Hub-Signature-256 de Meta:
  // hay que firmar exactamente los bytes recibidos, no el JSON reserializado.
  const app = await NestFactory.create(AppModule, { rawBody: true });

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );

  const config = app.get(AppConfigService);
  app.enableShutdownHooks();

  await app.listen(config.port);
  new Logger('Bootstrap').log(
    `Servidor escuchando en el puerto ${config.port} (WhatsApp driver: ${config.whatsapp.driver})`,
  );
}

void bootstrap();
