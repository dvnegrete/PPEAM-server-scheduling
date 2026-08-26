import { Module } from '@nestjs/common';
import { AssignmentsService } from './assignments.service';
import { CoverageService } from './coverage.service';
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
  ],
  exports: [
    ShiftsService,
    ScheduleGeneratorService,
    ScheduleMaintenanceService,
    CoverageService,
    AssignmentsService,
  ],
})
export class SchedulingModule {}
