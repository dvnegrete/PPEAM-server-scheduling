import { Global, Module } from '@nestjs/common';
import { ParticipantsService } from './participants.service';

@Global()
@Module({
  providers: [ParticipantsService],
  exports: [ParticipantsService],
})
export class ParticipantsModule {}
