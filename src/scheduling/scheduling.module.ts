import { Module } from '@nestjs/common';
import { AssignmentsService } from './assignments.service';
import { CoverageService } from './coverage.service';
import { RecurringAssignmentsService } from './recurring-assignments.service';
import { RecurringSyncService } from './recurring-sync.service';
import { ScheduleGeneratorService } from './schedule-generator.service';
import { ScheduleMaintenanceService } from './schedule-maintenance.service';
import { ShiftsService } from './shifts.service';

@Module({
  providers: [
    ShiftsService,
    ScheduleGeneratorService,
    ScheduleMaintenanceService,
    CoverageService,
    AssignmentsService,
    RecurringAssignmentsService,
    RecurringSyncService,
  ],
  exports: [
    ShiftsService,
    ScheduleGeneratorService,
    ScheduleMaintenanceService,
    CoverageService,
    AssignmentsService,
    RecurringAssignmentsService,
    RecurringSyncService,
  ],
})
export class SchedulingModule {}
