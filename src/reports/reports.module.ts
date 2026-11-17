import { Module } from '@nestjs/common';
import { AuditTrailService } from './audit-trail.service';
import { ConfirmationsDraftService } from './confirmations-draft.service';
import { PollDraftService } from './poll-draft.service';
import { ReportsService } from './reports.service';

@Module({
  providers: [ReportsService, AuditTrailService, PollDraftService, ConfirmationsDraftService],
  exports: [ReportsService, AuditTrailService, PollDraftService, ConfirmationsDraftService],
})
export class ReportsModule {}
