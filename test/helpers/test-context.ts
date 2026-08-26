import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { AuditModule } from '../../src/audit/audit.module';
import { DomainEventsModule } from '../../src/events/events.module';
import { PhoneModule } from '../../src/common/phone/phone.module';
import { SettingsModule } from '../../src/common/settings/settings.module';
import { TimeModule } from '../../src/common/time/time.module';
import { TimeService } from '../../src/common/time/time.service';
import { AppConfigModule } from '../../src/config/config.module';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ScheduleModule } from '@nestjs/schedule';
import { ConversationModule } from '../../src/conversation/conversation.module';
import { MessagingModule } from '../../src/messaging/messaging.module';
import { ParticipantsModule } from '../../src/participants/participants.module';
import { SchedulingModule } from '../../src/scheduling/scheduling.module';
import { SupervisorsModule } from '../../src/supervisors/supervisors.module';
import { ThreadsModule } from '../../src/threads/threads.module';
import { WhatsAppModule } from '../../src/whatsapp/whatsapp.module';

export interface TestContext {
  module: TestingModule;
  prisma: PrismaService;
  time: TimeService;
  events: EventEmitter2;
  close(): Promise<void>;
}

/** Tablas en orden inverso de dependencia, para poder truncar sin violar llaves. */
const TABLES = [
  'audit_logs',
  'thread_messages',
  'question_threads',
  'supervisor_tasks',
  'coverage_offers',
  'coverage_requests',
  'assignments',
  'shifts',
  'recurring_assignments',
  'shift_templates',
  'supervisor_windows',
  'supervisor_presence',
  'conversation_sessions',
  'outbox_messages',
  'inbound_messages',
  'location_memberships',
  'participants',
  'locations',
  'admin_users',
];

/** Contexto con la aplicación completa: usado por las pruebas de extremo a extremo. */
export async function createFullTestContext(): Promise<TestContext> {
  return createTestContext([
    ScheduleModule.forRoot(),
    WhatsAppModule,
    ParticipantsModule,
    SupervisorsModule,
    ThreadsModule,
    MessagingModule,
    ConversationModule,
  ]);
}

export async function createTestContext(extraImports: unknown[] = []): Promise<TestContext> {
  const module = await Test.createTestingModule({
    imports: [
      AppConfigModule,
      PrismaModule,
      TimeModule,
      PhoneModule,
      SettingsModule,
      AuditModule,
      EventEmitterModule.forRoot(),
      DomainEventsModule,
      SchedulingModule,
      ...(extraImports as never[]),
    ],
  }).compile();

  await module.init();

  const prisma = module.get(PrismaService);
  return {
    module,
    prisma,
    time: module.get(TimeService),
    events: module.get(EventEmitter2),
    close: async () => {
      await module.close();
    },
  };
}

export async function resetDatabase(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${TABLES.map((table) => `"${table}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
}
