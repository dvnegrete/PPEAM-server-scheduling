import { Global, Module } from '@nestjs/common';
import { MembershipsService } from './memberships.service';
import { OrganizationFieldsService } from './organization-fields.service';
import { ParticipantsService } from './participants.service';

@Global()
@Module({
  providers: [ParticipantsService, OrganizationFieldsService, MembershipsService],
  exports: [ParticipantsService, OrganizationFieldsService, MembershipsService],
})
export class ParticipantsModule {}
