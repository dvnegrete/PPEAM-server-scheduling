import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { SupervisorsModule } from '../supervisors/supervisors.module';
import { ThreadsModule } from '../threads/threads.module';
import { ConversationService } from './conversation.service';
import { SessionService } from './session.service';
import { SupervisorFlow } from './supervisor.flow';

@Module({
  imports: [SchedulingModule, SupervisorsModule, ThreadsModule, MessagingModule],
  providers: [ConversationService, SessionService, SupervisorFlow],
  exports: [ConversationService, SessionService],
})
export class ConversationModule {}
