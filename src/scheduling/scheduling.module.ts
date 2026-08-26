import { Module } from '@nestjs/common';
import { AssignmentsService } from './assignments.service';
import { CoverageService } from './coverage.service';
import { ScheduleGeneratorService } from './schedule-generator.service';
import { ShiftsService } from './shifts.service';

@Module({
  providers: [ShiftsService, ScheduleGeneratorService, CoverageService, AssignmentsService],
  exports: [ShiftsService, ScheduleGeneratorService, CoverageService, AssignmentsService],
})
export class SchedulingModule {}
