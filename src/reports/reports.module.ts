import { Module } from '@nestjs/common';
import { PollDraftService } from './poll-draft.service';
import { ReportsService } from './reports.service';

@Module({
  providers: [ReportsService, PollDraftService],
  exports: [ReportsService, PollDraftService],
})
export class ReportsModule {}
