import { Module } from '@nestjs/common';
import { AuditTrailService } from './audit-trail.service';
import { ConfirmationsDraftService } from './confirmations-draft.service';
import { DashboardService } from './dashboard.service';
import { MonthRosterService } from './month-roster.service';
import { PollDraftService } from './poll-draft.service';
import { ReportsService } from './reports.service';

@Module({
  providers: [
    ReportsService,
    AuditTrailService,
    DashboardService,
    MonthRosterService,
    PollDraftService,
    ConfirmationsDraftService,
  ],
  exports: [
    ReportsService,
    AuditTrailService,
    DashboardService,
    MonthRosterService,
    PollDraftService,
    ConfirmationsDraftService,
  ],
})
export class ReportsModule {}
