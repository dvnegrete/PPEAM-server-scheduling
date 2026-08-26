import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { AuditModule } from './audit/audit.module';
import { SettingsModule } from './common/settings/settings.module';
import { TimeModule } from './common/time/time.module';
import { AppConfigModule } from './config/config.module';
import { PhoneModule } from './common/phone/phone.module';
import { PrismaModule } from './prisma/prisma.module';
import { WhatsAppModule } from './whatsapp/whatsapp.module';

@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    TimeModule,
    PhoneModule,
    SettingsModule,
    AuditModule,
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),
    WhatsAppModule,
  ],
})
export class AppModule {}
