import { Module } from '@nestjs/common';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { SupervisorTaskListeners } from './supervisor-task.listeners';
import { SupervisorTasksScheduler } from './supervisor-tasks.scheduler';
import { SupervisorTasksService } from './supervisor-tasks.service';
import { SupervisorsService } from './supervisors.service';

@Module({
  imports: [SchedulingModule],
  providers: [
    SupervisorsService,
    SupervisorTasksService,
    SupervisorTaskListeners,
    SupervisorTasksScheduler,
  ],
  exports: [SupervisorsService, SupervisorTasksService, SupervisorTasksScheduler],
})
export class SupervisorsModule {}
