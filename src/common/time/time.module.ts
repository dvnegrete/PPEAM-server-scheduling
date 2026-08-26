import { Global, Module } from '@nestjs/common';
import { TimeService } from './time.service';

@Global()
@Module({
  providers: [TimeService],
  exports: [TimeService],
})
export class TimeModule {}
