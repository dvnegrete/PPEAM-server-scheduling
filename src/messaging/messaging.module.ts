import { Module } from '@nestjs/common';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { SupervisorsModule } from '../supervisors/supervisors.module';
import { ConversationWindowService } from './conversation-window.service';
import { MessageComposer } from './message-composer';
import { NotificationListeners } from './notification.listeners';
import { NotificationService } from './notification.service';

@Module({
  imports: [SchedulingModule, SupervisorsModule],
  providers: [
    MessageComposer,
    ConversationWindowService,
    NotificationService,
    NotificationListeners,
  ],
  exports: [MessageComposer, ConversationWindowService, NotificationService],
})
export class MessagingModule {}
