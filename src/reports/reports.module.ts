import { Module } from '@nestjs/common';
import { ConfirmationsDraftService } from './confirmations-draft.service';
import { PollDraftService } from './poll-draft.service';
import { ReportsService } from './reports.service';

@Module({
  providers: [ReportsService, PollDraftService, ConfirmationsDraftService],
  exports: [ReportsService, PollDraftService, ConfirmationsDraftService],
})
export class ReportsModule {}
