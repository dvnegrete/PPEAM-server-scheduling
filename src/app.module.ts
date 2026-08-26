import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { AdminModule } from './admin/admin.module';
import { AuditModule } from './audit/audit.module';
import { DomainEventsModule } from './events/events.module';
import { SettingsModule } from './common/settings/settings.module';
import { TimeModule } from './common/time/time.module';
import { AppConfigModule } from './config/config.module';
import { PhoneModule } from './common/phone/phone.module';
import { PrismaModule } from './prisma/prisma.module';
import { ConversationModule } from './conversation/conversation.module';
import { ImportModule } from './import/import.module';
import { MessagingModule } from './messaging/messaging.module';
import { ParticipantsModule } from './participants/participants.module';
import { SchedulingModule } from './scheduling/scheduling.module';
import { ReportsModule } from './reports/reports.module';
import { ThreadsModule } from './threads/threads.module';
import { SupervisorsModule } from './supervisors/supervisors.module';
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
    DomainEventsModule,
    WhatsAppModule,
    SchedulingModule,
    SupervisorsModule,
    ParticipantsModule,
    ThreadsModule,
    MessagingModule,
    ConversationModule,
    ImportModule,
    ReportsModule,
    AdminModule,
  ],
})
export class AppModule {}
