import { Module } from '@nestjs/common';
import { ThreadsService } from './threads.service';

@Module({
  providers: [ThreadsService],
  exports: [ThreadsService],
})
export class ThreadsModule {}
