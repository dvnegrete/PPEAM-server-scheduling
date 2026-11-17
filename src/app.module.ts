import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { AdminModule } from './admin/admin.module';
import { AuditModule } from './audit/audit.module';
import { DomainEventsModule } from './events/events.module';
import { SettingsModule } from './common/settings/settings.module';
import { TimeModule } from './common/time/time.module';
import { AppConfigService } from './config/app-config.service';
import { AppConfigModule } from './config/config.module';
import { PhoneModule } from './common/phone/phone.module';
import { DatabaseUnavailableFilter } from './prisma/database-unavailable.filter';
import { DatabaseWakeMiddleware } from './prisma/database-wake.middleware';
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
    // Con las tareas apagadas no se registra ningún temporizador: el proceso
    // queda quieto entre peticiones y la plataforma puede dormirlo.
    ScheduleModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({ cronJobs: config.backgroundJobsEnabled }),
    }),
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
  providers: [{ provide: APP_FILTER, useClass: DatabaseUnavailableFilter }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Antes de cualquier ruta: la base puede estar dormida y hay que esperarla.
    consumer.apply(DatabaseWakeMiddleware).forRoutes('{*splat}');
  }
}
