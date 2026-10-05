import { Global, Module } from '@nestjs/common';
import { OrganizationFieldsService } from './organization-fields.service';
import { ParticipantsService } from './participants.service';

@Global()
@Module({
  providers: [ParticipantsService, OrganizationFieldsService],
  exports: [ParticipantsService, OrganizationFieldsService],
})
export class ParticipantsModule {}
