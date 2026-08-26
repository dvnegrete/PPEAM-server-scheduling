import { Module } from '@nestjs/common';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { SupervisorsModule } from '../supervisors/supervisors.module';
import { ConversationWindowService } from './conversation-window.service';
import { MessageComposer } from './message-composer';
import { NotificationListeners } from './notification.listeners';
import { NotificationService } from './notification.service';
import { RemindersService } from './reminders.service';

@Module({
  imports: [SchedulingModule, SupervisorsModule],
  providers: [
    MessageComposer,
    ConversationWindowService,
    NotificationService,
    NotificationListeners,
    RemindersService,
  ],
  exports: [MessageComposer, ConversationWindowService, NotificationService, RemindersService],
})
export class MessagingModule {}
